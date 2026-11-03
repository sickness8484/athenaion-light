"""Bake the authored cloud noise shader into RGBA8 volumes using software EGL.

Run `python3 tools/bake-clouds.py` before building the site. Linux needs libegl1
and libgl1-mesa-dri; the baker itself uses only Python's standard library.
Pixels use OpenGL's bottom-to-top row order, matching Data3DTexture.flipY=false.
The shader and dimensions are unchanged from the original runtime generator.
"""
import argparse
import ctypes as C
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import time

os.environ.setdefault('MESA_SHADER_CACHE_DIR', '/tmp/athenaion-cloud-shader-cache')
os.environ.setdefault('LIBGL_ALWAYS_SOFTWARE', '1')
ROOT = Path(__file__).resolve().parents[1]

class SoftwareGL:
    def __init__(self):
        self.egl = C.CDLL('libEGL.so.1')
        self.egl.eglGetProcAddress.argtypes = [C.c_char_p]
        self.egl.eglGetProcAddress.restype = C.c_void_p
        address = self.egl.eglGetProcAddress(b'eglGetPlatformDisplayEXT')
        if not address:
            raise RuntimeError('Surfaceless Mesa EGL is required to bake cloud noise')
        get_display = C.CFUNCTYPE(C.c_void_p, C.c_uint, C.c_void_p, C.POINTER(C.c_int))(address)
        self.display = get_display(0x31DD, None, None)
        major, minor = C.c_int(), C.c_int()
        self.require(self.ef('eglInitialize', C.c_uint, [C.c_void_p, C.POINTER(C.c_int), C.POINTER(C.c_int)])(self.display, C.byref(major), C.byref(minor)), 'initialize EGL')
        self.require(self.ef('eglBindAPI', C.c_uint, [C.c_uint])(0x30A0), 'select OpenGL ES')
        attrs = (C.c_int * 15)(0x3024, 8, 0x3023, 8, 0x3022, 8, 0x3021, 8, 0x3033, 1, 0x3040, 0x40, 0x3025, 0, 0x3038)
        config, count = C.c_void_p(), C.c_int()
        self.require(self.ef('eglChooseConfig', C.c_uint, [C.c_void_p, C.POINTER(C.c_int), C.POINTER(C.c_void_p), C.c_int, C.POINTER(C.c_int)])(self.display, attrs, C.byref(config), 1, C.byref(count)) and count.value, 'choose EGL config')
        self.context = self.ef('eglCreateContext', C.c_void_p, [C.c_void_p, C.c_void_p, C.c_void_p, C.POINTER(C.c_int)])(self.display, config, None, (C.c_int * 3)(0x3098, 3, 0x3038))
        self.require(self.context, 'create OpenGL ES 3 context')
        self.surface = self.ef('eglCreatePbufferSurface', C.c_void_p, [C.c_void_p, C.c_void_p, C.POINTER(C.c_int)])(self.display, config, (C.c_int * 5)(0x3057, 1, 0x3056, 1, 0x3038))
        self.require(self.ef('eglMakeCurrent', C.c_uint, [C.c_void_p, C.c_void_p, C.c_void_p, C.c_void_p])(self.display, self.surface, self.surface, self.context), 'make EGL context current')

    def ef(self, name, result, args):
        fn = getattr(self.egl, name)
        fn.restype, fn.argtypes = result, args
        return fn

    @staticmethod
    def require(success, operation):
        if not success:
            raise RuntimeError('Failed to ' + operation)

    def gl(self, name, result, args):
        address = self.egl.eglGetProcAddress(name.encode())
        self.require(address, 'find ' + name)
        return C.CFUNCTYPE(result, *args)(address)

    def shader(self, kind, source):
        shader = self.gl('glCreateShader', C.c_uint, [C.c_uint])(kind)
        encoded = C.c_char_p(source.encode())
        self.gl('glShaderSource', None, [C.c_uint, C.c_int, C.POINTER(C.c_char_p), C.POINTER(C.c_int)])(shader, 1, C.byref(encoded), None)
        self.gl('glCompileShader', None, [C.c_uint])(shader)
        success = C.c_int()
        self.gl('glGetShaderiv', None, [C.c_uint, C.c_uint, C.POINTER(C.c_int)])(shader, 0x8B81, C.byref(success))
        if not success.value:
            log = C.create_string_buffer(65536)
            self.gl('glGetShaderInfoLog', None, [C.c_uint, C.c_int, C.POINTER(C.c_int), C.c_char_p])(shader, len(log), None, log)
            raise RuntimeError(log.value.decode())
        return shader

    def program(self, fragment):
        vertex = '#version 300 es\nprecision highp float;out vec2 vUv;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);vUv=p;gl_Position=vec4(p*2.0-1.0,0,1);}'
        fragment = '#version 300 es\nprecision highp float;\n#define varying in\nout vec4 outputColor;\n#define gl_FragColor outputColor\n' + fragment
        program = self.gl('glCreateProgram', C.c_uint, [])()
        shaders = [self.shader(0x8B31, vertex), self.shader(0x8B30, fragment)]
        for shader in shaders:
            self.gl('glAttachShader', None, [C.c_uint, C.c_uint])(program, shader)
        self.gl('glLinkProgram', None, [C.c_uint])(program)
        success = C.c_int()
        self.gl('glGetProgramiv', None, [C.c_uint, C.c_uint, C.POINTER(C.c_int)])(program, 0x8B82, C.byref(success))
        if not success.value:
            log = C.create_string_buffer(65536)
            self.gl('glGetProgramInfoLog', None, [C.c_uint, C.c_int, C.POINTER(C.c_int), C.c_char_p])(program, len(log), None, log)
            raise RuntimeError(log.value.decode())
        for shader in shaders:
            self.gl('glDeleteShader', None, [C.c_uint])(shader)
        return program

    def volume(self, program, size, mode):
        texture, framebuffer, vao = C.c_uint(), C.c_uint(), C.c_uint()
        self.gl('glGenTextures', None, [C.c_int, C.POINTER(C.c_uint)])(1, C.byref(texture))
        self.gl('glBindTexture', None, [C.c_uint, C.c_uint])(0x0DE1, texture.value)
        parameter = self.gl('glTexParameteri', None, [C.c_uint, C.c_uint, C.c_int])
        parameter(0x0DE1, 0x2801, 0x2600); parameter(0x0DE1, 0x2800, 0x2600)
        self.gl('glTexImage2D', None, [C.c_uint, C.c_int, C.c_int, C.c_int, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_void_p])(0x0DE1, 0, 0x8058, size, size, 0, 0x1908, 0x1401, None)
        self.gl('glGenFramebuffers', None, [C.c_int, C.POINTER(C.c_uint)])(1, C.byref(framebuffer))
        self.gl('glBindFramebuffer', None, [C.c_uint, C.c_uint])(0x8D40, framebuffer.value)
        self.gl('glFramebufferTexture2D', None, [C.c_uint, C.c_uint, C.c_uint, C.c_uint, C.c_int])(0x8D40, 0x8CE0, 0x0DE1, texture.value, 0)
        self.require(self.gl('glCheckFramebufferStatus', C.c_uint, [C.c_uint])(0x8D40) == 0x8CD5, 'create RGBA8 framebuffer')
        self.gl('glGenVertexArrays', None, [C.c_int, C.POINTER(C.c_uint)])(1, C.byref(vao))
        self.gl('glBindVertexArray', None, [C.c_uint])(vao.value)
        self.gl('glUseProgram', None, [C.c_uint])(program)
        self.gl('glViewport', None, [C.c_int, C.c_int, C.c_int, C.c_int])(0, 0, size, size)
        location = self.gl('glGetUniformLocation', C.c_int, [C.c_uint, C.c_char_p])
        z_location = location(program, b'uZ')
        set_float = self.gl('glUniform1f', None, [C.c_int, C.c_float])
        set_float(location(program, b'uMode'), float(mode))
        draw = self.gl('glDrawArrays', None, [C.c_uint, C.c_int, C.c_int])
        read = self.gl('glReadPixels', None, [C.c_int, C.c_int, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_void_p])
        raw = bytearray(size ** 3 * 4)
        layer = (C.c_ubyte * (size * size * 4))()
        try:
            for z in range(size):
                set_float(z_location, (z + 0.5) / size)
                draw(4, 0, 3)
                read(0, 0, size, size, 0x1908, 0x1401, layer)
                raw[z * len(layer):(z + 1) * len(layer)] = layer
            self.require(self.gl('glGetError', C.c_uint, [])() == 0, 'render cloud volume')
            return bytes(raw)
        finally:
            self.gl('glDeleteVertexArrays', None, [C.c_int, C.POINTER(C.c_uint)])(1, C.byref(vao))
            self.gl('glDeleteFramebuffers', None, [C.c_int, C.POINTER(C.c_uint)])(1, C.byref(framebuffer))
            self.gl('glDeleteTextures', None, [C.c_int, C.POINTER(C.c_uint)])(1, C.byref(texture))

    def close(self):
        self.ef('eglMakeCurrent', C.c_uint, [C.c_void_p, C.c_void_p, C.c_void_p, C.c_void_p])(self.display, None, None, None)
        self.ef('eglDestroySurface', C.c_uint, [C.c_void_p, C.c_void_p])(self.display, self.surface)
        self.ef('eglDestroyContext', C.c_uint, [C.c_void_p, C.c_void_p])(self.display, self.context)
        self.ef('eglTerminate', C.c_uint, [C.c_void_p])(self.display)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / 'src/core/sky.js')
    parser.add_argument('--output', type=Path, default=ROOT / 'generated/cloud-noise')
    args = parser.parse_args()
    source = args.source.read_text()
    if args.source.suffix == '.js':
        match = re.search(r'(?:export )?const (?:CLOUD_NOISE_FRAGMENT_SHADER|GEN_FRAG) = /\* glsl \*/ `([\s\S]*?)`;', source)
        if not match:
            raise RuntimeError('Authored cloud generator shader not found')
        source = match.group(1)
    source_hash = hashlib.sha256(source.encode()).hexdigest()
    args.output.mkdir(parents=True, exist_ok=True)
    context = SoftwareGL()
    try:
        renderer = context.gl('glGetString', C.c_char_p, [C.c_uint])(0x1F01).decode()
        program = context.program(source)
        textures = {}
        for name, size, mode in [('shape', 128, 0), ('detail', 64, 1)]:
            start = time.monotonic()
            raw = context.volume(program, size, mode)
            sha = hashlib.sha256(raw).hexdigest()
            filename = f'{name}-{size}.{sha[:12]}.rgba8.gz'
            compressed = gzip.compress(raw, compresslevel=9, mtime=0)
            (args.output / filename).write_bytes(compressed)
            textures[name] = {'size': size, 'rawBytes': len(raw), 'bytes': len(compressed), 'sha256': sha, 'file': filename, 'encoding': 'gzip'}
            print(json.dumps({'name': name, **textures[name], 'seconds': round(time.monotonic() - start, 3)}), flush=True)
        context.gl('glDeleteProgram', None, [C.c_uint])(program)
        manifest = {'formatVersion': 1, 'sourceHash': source_hash, 'renderer': renderer, 'textures': textures}
        (args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    finally:
        context.close()

if __name__ == '__main__':
    main()

// The renderer is typechecked WITHOUT @types/node (it runs in a sandbox: no `process`, no `require`).
// src/shared/api.ts references NodeJS.Platform, so declare just that one type for the web program.
declare namespace NodeJS {
  type Platform =
    | 'aix'
    | 'android'
    | 'darwin'
    | 'freebsd'
    | 'haiku'
    | 'linux'
    | 'openbsd'
    | 'sunos'
    | 'win32'
    | 'cygwin'
    | 'netbsd';
}

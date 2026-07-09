// Minimal ambient types for utif (UTIF.js) — the package ships no typings.
declare module 'utif' {
  export interface IFD {
    width: number
    height: number
    data?: Uint8Array
    [key: string]: unknown
  }
  export function decode(buf: ArrayBuffer | Uint8Array): IFD[]
  export function decodeImage(buf: ArrayBuffer | Uint8Array, ifd: IFD, ifds?: IFD[]): void
  export function toRGBA8(ifd: IFD): Uint8Array
}

// The spine-core type declarations name two browser types. This package does not use them.
// These minimal declarations let the type check run with the Node.js library only. They merge with the DOM library when it is present.
declare global {
  interface HTMLImageElement {
    readonly src: string;
  }
  interface ImageBitmap {
    readonly width: number;
  }
}

export {};

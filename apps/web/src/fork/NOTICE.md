# Third-party notices for the fork's own pieces

Pieces under `apps/web/src/fork/` and `themes/t3-fork-v4.json` use the following
third-party work.

## Geist and Geist Mono

- What: the variable `woff2` files in `fonts/` (latin, latin-ext and cyrillic, weights 100-900).
- Where from: npm `@fontsource-variable/geist@5.3.0` and `@fontsource-variable/geist-mono@5.3.0`
  (Geist v5), which repackage <https://github.com/vercel/geist-font>.
- License: SIL Open Font License 1.1, "Copyright 2024 The Geist Project Authors". The full
  text is in `fonts/OFL.txt`.

## Phosphor Icons

- What: the npm package `@phosphor-icons/react`, used in the fork's own components.
- Where from: <https://github.com/phosphor-icons/react>
- License: MIT, "Copyright (c) 2020 Phosphor Icons". The full text ships in the package.

## dithercn

- What: parts of its dither core in `dither/` (`blue-noise.ts` verbatim; `matrices.ts`,
  `tokens.ts`, `pattern.ts` and `style.ts` trimmed to what the fork uses).
- Where from: <https://github.com/opencoredev/dithercn>, `lib/dither/` at commit
  `3b1e85384c9ab05d381612d5520342dc38809adb` (main, 5 November 2026). The same files are
  served by <https://dithercn.dev/r/dither-core.json>.
- License: MIT. Full text:

```
MIT License

Copyright (c) 2026 Leo
Copyright (c) 2026 Shadcn Labs (startercn, which this project is based on)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ADE home background (`apps/ade/src/home/home-art.png`)

- What: a dithered rendering of Ansel Adams, «The Tetons – Snake River» (1942).
- Where from: U.S. National Archives, identifier 519904.
- License: public domain, a work of the U.S. Government (17 U.S.C. § 105).

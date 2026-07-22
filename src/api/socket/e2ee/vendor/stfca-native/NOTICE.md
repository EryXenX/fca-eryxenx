# Third-Party Notice

This directory contains a native E2EE engine compiled from
**mautrix-meta's `messagix` package** (https://github.com/mautrix/meta),
by Tulir Asokan / mau.fi — licensed **AGPL-3.0**, NOT MIT.

Obtained via the `stfca` npm package (Sheikh Tamim / ST-FCA), which
compiles this upstream library into `messagix.so` and exposes it via a
`koffi` FFI bridge (`index.mjs`). ST-FCA's own package.json says "MIT",
but that label does not apply to this binary — its true upstream license
is AGPL-3.0.

## ⚠️ AGPL-3.0 network-use obligation

If this bot interacts with users over a network (Messenger), AGPL-3.0
requires making the complete source of the whole combined program
available to those users. This was flagged to the repository owner
(Mohammad Akash / EryXenX) on 2026-07-20; using it anyway, with this
known, was the owner's decision.

## Old placeholder text kept below for reference only — see above for the
## corrected/accurate license situation.

Copyright (c) Sheikh Tamim

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.

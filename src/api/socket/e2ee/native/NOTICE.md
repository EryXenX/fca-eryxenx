# Third-Party Notice

The files in `native/build/messagix.so` and `native/build/messagix.dll`
are precompiled native binaries built from:

- **mautrix-go** — https://github.com/mautrix/go
- **mautrix-meta** — https://github.com/mautrix/meta

Copyright (c) Tulir Asokan and the mautrix-go / mautrix-meta contributors.

Both projects are licensed under the **Mozilla Public License 2.0 (MPL-2.0)**.
A copy of the license is available at:
https://www.mozilla.org/en-US/MPL/2.0/

`native/lib/index.mjs` is the Node.js FFI bridge (via `koffi`) used to call
into the compiled binary, adapted from the same upstream project's Node
bindings.

fca-eryxenx uses this native engine only for sending E2EE media attachments
(images/video/audio/documents) in end-to-end encrypted Messenger threads,
because the project's own hand-written Signal Protocol media encoder
(`../vendor/fme`) produces payloads that Facebook's servers accept but that
Messenger clients fail to render. Text messages and all non-media E2EE
functionality continue to use fca-eryxenx's original implementation.

In accordance with MPL-2.0 §3.3, this NOTICE file must be preserved and
distributed alongside these files, and any modifications to the covered
source files (if the original `.mjs`/Go source is later vendored here)
must remain under MPL-2.0 and have their source made available.

# Demo Hub — demos.planetek.org

The boardwalk entrance: a zero-JS static one-pager (S3 + CloudFront, strict
CSP with `script-src 'none'`) with one card per live environment. Publish
with `make publish`; infra follows the standard plank patterns in `infra/`.

## Hero photo provenance

`site/boardwalk-night.webp` — foggy harbor pier at night by Christian Lue,
via Unsplash (https://unsplash.com/photos/yLZPjCsY6H8), downloaded 2026-07-20
through the official download endpoint. Unsplash License: free for commercial
use, no attribution required (credited anyway). Scaled to 1920px, WebP q62
≈ 32 KB, self-hosted to satisfy the CSP.

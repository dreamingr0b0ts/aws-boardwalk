# Demo Hub — demos.planetek.org

The boardwalk entrance: a zero-JS static one-pager (S3 + CloudFront, strict
CSP with `script-src 'none'`) with one card per live environment. Publish
with `make publish`; infra follows the standard plank patterns in `infra/`.

## Design

Identity: **the pier at lamplight**. The hub is the boardwalk itself. Dark
mode is the lamp-lit pier at night; light mode is the promenade at first
light, grounded on sun-bleached deck paper (never plain white). Each
environment card is a door along the pier: its top bar and label dot are
painted in the accent color of the identity that lives behind it (permits
alpenglow, drafting-room Prussian, signal-bench phosphor, records-office
nocturne, and so on). Status chips are lamps: always-on burns all night,
on-demand is lit when you arrive. A CSS deck-board strip closes the hero
and tops the footer, and the principles section is a routed "Pier notice"
board with glowing lamp bullets.

Type: Josefin Sans (display, uppercase, a vintage resort-pavilion voice) +
Mulish (body) + Red Hat Mono (labels, chips, stack lines). Static woff2
vendored in `site/fonts/` (the CSP allows no font CDNs).

Photo provenance (both via Unsplash official download endpoints; Unsplash
License: free for commercial use, no attribution required, credited anyway):

- `site/boardwalk-night.webp`: foggy harbor pier at night by Christian Lue
  (https://unsplash.com/photos/yLZPjCsY6H8), downloaded 2026-07-20. Scaled
  to 1920px, WebP q62, about 32 KB, self-hosted to satisfy the CSP.
- `site/promenade-first-light.webp`: lamp-lined lakeside promenade at first
  light by Ahmet Yüksek (https://unsplash.com/photos/yo2oAL5txkk),
  downloaded 2026-07-23, focal-point crop 1600x600, WebP q60, about 80 KB.

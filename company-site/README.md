# company-site — planetek.org

The Planetek LLC company homepage, moved from a DigitalOcean droplet onto the
same AWS patterns as the rest of the boardwalk: private S3 + CloudFront (OAC,
strict security headers), a same-origin `/api/contact` HTTP API (Lambda → SES →
info@planetek.org), and the Route53 hosted zone for the apex domain itself —
including the iCloud custom-domain mail records, replicated verbatim from
GoDaddy so the nameserver cutover never touches email.

| Piece | What |
| --- | --- |
| `site/` | Dependency-free static one-pager (SEO: canonical, OG, JSON-LD, sitemap) + privacy/terms/404 |
| `backend/contact.mjs` | Contact form Lambda: honeypot, validation, per-IP + global daily caps (DynamoDB TTL counters), SESv2 send |
| `infra/` | Zone (`prevent_destroy`), ACM cert (DNS-validated), CloudFront + router function (www→apex, clean URLs), HTTP API, SES identities |

## Cutover runbook (owner does the GoDaddy steps)

1. `make deploy` — everything except the custom domain goes live on the
   `*.cloudfront.net` URL. `make outputs` prints the ACM validation CNAMEs and
   the four Route53 nameservers.
2. At GoDaddy: add the two ACM validation CNAMEs. Wait for `make cert-status`
   to show ISSUED.
3. Click the SES verification link that arrived at info@planetek.org (sent when
   the identity was created).
4. Flip `custom_domain_enabled` default to `true` in `infra/main.tf`, apply,
   verify, push.
5. At GoDaddy: change the domain's nameservers to the four from `make outputs`.
   Email keeps working (records replicated); the site cuts over as caches expire.
6. Retire the DigitalOcean droplet when comfortable (drift.planetek.org still
   points at it until then).

Sandbox note: SES stays in sandbox on purpose — mail only flows info@ → info@
(visitor's address rides in Reply-To), which the sandbox allows once info@ is
verified. Domain DKIM CNAMEs live in the zone and verify automatically after
the NS cutover, giving DMARC-aligned signatures.

`make verify` runs the end-to-end suite; `SEND=1 make verify` also sends one
real test email.

## Hero photo provenance

`site/assets/hero-city.webp` — night cityscape by Chi Hung Wong, via Unsplash
(https://unsplash.com/photos/jODJ4np77W8), downloaded 2026-07-20 through the
official download endpoint. Unsplash License: free for commercial use, no
attribution required (credited anyway). Cropped to the upper tower band
(street-level signage removed), 1920px, WebP q62 ≈ 114 KB, self-hosted to
satisfy the site's `img-src 'self'` CSP.

# company-site — planetek.org

The Planetek LLC company homepage, moved from a DigitalOcean droplet onto the
same AWS patterns as the rest of the boardwalk: private S3 + CloudFront (OAC,
strict security headers), a same-origin `/api/contact` HTTP API (Lambda → SES →
info@planetek.org), and the Route53 hosted zone for the apex domain itself —
including the iCloud custom-domain mail records, replicated verbatim from
GoDaddy so the nameserver cutover never touches email.

| Piece | What |
| --- | --- |
| `site/` | Dependency-free static site: homepage, five service pages (three core in the nav; see the service hierarchy note below), /apps + a page per shipped app, /about, /schedule, insights + three field notes, privacy/terms/404 (SEO: canonical, OG, JSON-LD, sitemap, RSS at /feed.xml) |
| `backend/contact.mjs` | Contact form Lambda: honeypot, validation, per-visitor (10/day) + global (100/day) caps (DynamoDB TTL counters), SESv2 send |
| `backend/schedule.mjs` | Booking desk Lambda: computed availability, one conditional write per slot, per-visitor (3/day) + global (10/day) caps, owner invite + optional visitor confirmation. A booking whose owner invite cannot be sent is undone. |
| `backend/test/` | Offline tests for both (`make test`): stubbed SES and DynamoDB, no AWS calls |

**How the daily caps count.** Both Lambdas sit behind CloudFront, so the address API Gateway reports
(`sourceIp`) is one of CloudFront's own: many visitors share one and one visitor arrives from many.
The caps key on the visitor instead, the second-from-last `X-Forwarded-For` entry, which CloudFront
writes and a client cannot (the origin lock is what makes that position trustworthy). The key is a
hash of the address, IPv6 by /64, so the counter table holds no addresses. A claim against a cap is
handed back whenever the request ends without a message sent or a booking made, so the caps count
results and not attempts.
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

## Service hierarchy (restructured 2026-08-05)

Three core services carry the primary nav and the homepage grid: Managed AWS,
Federal, and Fractional Leadership. The other two pages stay live at their
original URLs (SEO intact, linked from the homepage "More from the practice"
grouping and every footer) but were demoted and reframed:

- `/ai-training` is now **AI Enablement & Training**, positioned inside the
  AWS practice ("we build your Bedrock stack and train your team to use it");
  the models and assistant planks double as its classroom.
- `/web-development` is now **Application Delivery on AWS**, led by the
  Alpenglow permit portal; marketing-site work is secondary and the Cornell
  certificate is a credentials line, not a headline.

`scripts/verify.sh` greps for the new H1s; the /about education list still
carries the Cornell certificate.

## Apps (added 2026-09-16)

Planetek ships its own products, not only client work, and they live under
`/apps`: a hub at `site/apps.html` and **one page per app** at
`site/apps/<slug>.html`. The split is deliberate and should not be collapsed
into a single combined page. A page per app gets its own title, description,
canonical, and `SoftwareApplication` markup, so each product can rank for its
own name instead of competing with its siblings, and a new app is a new file
rather than a restructure with redirects. The hub carries the nav slot and the
sitewide footer link. The pattern mirrors `/insights` + `/insights/<slug>`,
and the CloudFront router already maps nested extensionless paths to `.html`.

First app: **GovCon Radar** (`/apps/govcon-radar`), live on the App Store and
Google Play, product site `app.govconradar.com`. That site links back here, so
the two properties reinforce each other; keep both directions intact. Its repo
is `~/Developer/govcon-radar`, which is the source of truth for every claim on
the page — pricing, plan limits, and the store URLs live in `web/lib/seo.ts`
and `web/app/pricing/pricing-client.tsx`. When the product changes, this page
and `app.govconradar.com/pricing/` both have to move, and the page says out
loud that the product's own pricing page wins if they disagree.

Two rules the product's own copy standard imposes, carried over here because
the page is about it: never imply government endorsement (the page and its
FAQ JSON-LD both carry the "not affiliated with or endorsed by the U.S.
Government, SAM.gov, or any federal agency" line), and keep the Apple and
Google trademark attributions with the badges. The badges render at one
height, with the Play artwork wider, which Google's brand guidelines require.

Shipping a new app means: its page under `site/apps/`, a card on `/apps`, a
sitemap entry, and a `verify.sh` block (the existing one checks the store
links, the disclaimer, the JSON-LD, and every vendored asset). The nav, the
footer, and the homepage section already point at the hub, so they only change
when the hub does.

## Structured data (expanded 2026-08-05)

Every page carries JSON-LD; the sitewide review's checklist is fully covered:

- `/` — `Organization` (founder, Commerce City address, phone, sameAs) +
  `WebSite` + `ProfessionalService` (a LocalBusiness subtype: address, phone,
  Denver-metro `areaServed`, offer catalog for all five services).
- Five service pages — `Service` + `BreadcrumbList` + `FAQPage` built from the
  visible "Common questions" section. The FAQ copy in the JSON-LD must mirror
  the on-page text, with one deliberate exception: the managed-aws answer omits
  the auto-updated monthly cost figure so `tools/update_monthly_costs.py`'s
  single-marker invariant holds (the marker count check fails loudly if the
  phrase is ever duplicated).
- `/apps` — `CollectionPage` + `ItemList` + `BreadcrumbList`.
- `/apps/<app>` — `SoftwareApplication` (store listings in `sameAs`, the real
  `offers`, `publisher` pointing at the homepage `Organization` @id) +
  `BreadcrumbList` + `FAQPage` mirroring the visible questions.
- `/about` — `ProfilePage` + `Person` + `BreadcrumbList`.
- `/insights` — `Blog` + `BreadcrumbList`; each field note is a `BlogPosting`
  (Person author linked to `/about#person`, its own hero image, dates) +
  `BreadcrumbList`.
- `/schedule`, `/privacy`, `/terms` — `BreadcrumbList`.

Field-note dates (review item 5.4): the three launch posts originally all said
August 2, 2026, which read as a batch. They were re-dated 2026-08-05 to when
the underlying work actually happened: migration note July 19 (cutover was
July 17), GenAI guardrails note July 29 (visitor tiers shipped July 28-29),
cost note August 2 (needed July's closed bill). A post's visible stamp, its
JSON-LD `datePublished`, and the `/insights` card must stay in sync, and the
card list stays newest-first. The cadence itself still needs feeding: aim for
roughly one new field note a month, dated when it ships.

Bylines and RSS (added 2026-08-05): every field note is signed by Trevor
Lewis, not "Planetek LLC", because the site's whole pitch is one identifiable
engineer. Each post has a "By Trevor Lewis" stamp in the hero and a
`.post-author` card (headshot + /about link) above the closing CTA. The feed
is hand-maintained at `site/feed.xml` (RSS 2.0, `dc:creator`, permalink
guids); it is linked via `rel="alternate"` from the homepage, /insights, and
every post, plus a visible link under the /insights post list. Shipping a new
post means: the post page itself (copy an existing one: JSON-LD graph, stamp,
author card), a card on /insights + its Blog JSON-LD entry, a card on the
homepage (short-form dates there, long-form everywhere else), a feed.xml item
and `lastBuildDate` bump, and a sitemap entry. This checklist is enforced,
not just documented: `tools/check_field_notes.py` treats each post's
BlogPosting JSON-LD as the source of truth and fails `make verify` on any
date, ordering, or presence drift across those surfaces (the homepage cards
drifted exactly this way on 2026-08-06). Prose stays hand-authored per
surface on purpose; only the derived facts are checked.

## Design

Redesigned 2026-07-23 as "the town at the foot of the boardwalk": planetek.org
shares one visual language with demos.planetek.org (the hub's "pier at
lamplight"). Sun-bleached deck paper by day, lamp-lit pine by night, alpenglow
ember (`#e4532f`) as the brand color. Type: Josefin Sans (uppercase display) +
Mulish (body) + Red Hat Mono (machine voice), vendored woff2 in `site/fonts/`
to satisfy the `font-src 'self'` CSP. Signature moves: the hub's deck-board
divider closes the hero and tops the footer; service cards wear the door paint
of the live plank they link to; and a full-bleed "twelve doors" band renders
the whole boardwalk as twelve arched, lamp-lit doors in each plank's accent
color, each linking to its live environment. No service prices appear on the
page (owner decision 2026-07-23); credential stats remain.

Photo provenance (Unsplash License, free commercial use, credited in the
footer anyway; downloaded via the official endpoint, resized with CDN
transform params, self-hosted for the `img-src 'self'` CSP):

- `site/assets/hero-alpenglow.webp` — alpenglow on a jagged ridge by
  Royce Fonseca (https://unsplash.com/photos/K5Frw34P1XI), 1920x1200 ≈ 199 KB.
- `site/assets/dillon-dusk.webp` — dusk over the Tenmile Range, Summit County,
  Colorado by Tim Arterbury (https://unsplash.com/photos/n-zEC_AypI8),
  1600x640 ≈ 120 KB.
- `site/assets/og.jpg` — 1200x630 crop of the hero photo.

Interior-page heroes (added 2026-08-02, same license and pipeline, all
1600x900 webp, credited in each page's footer):

- `aws-village-dusk.webp` — snow-covered Swiss village at dusk by Livia
  (https://unsplash.com/photos/mjE1VxiGc-Y), /managed-aws.
- `federal-garden-gods.webp` — Garden of the Gods at first light by Mick Haupt
  (https://unsplash.com/photos/33XL5SnvuT0), /federal.
- `fractional-compass.webp` — brass compass on a vintage map by Denise Jans
  (https://unsplash.com/photos/9OBwt_VgPa0), /fractional-cto.
- `training-violet-sky.webp` — aurora and Milky Way over snowy spires by
  Gantavya Bhatt (https://unsplash.com/photos/kS9uGzbI-9A), /ai-training.
- `webdev-workbench.webp` — craftsman with hand planes by Minh Đức
  (https://unsplash.com/photos/lQIUbkn6jj4), /web-development.
- `insights-notebook.webp` — open notebook and pen by Clay Banks
  (https://unsplash.com/photos/n9AaeihA9HI), /insights.
- `apps-radar-domes.webp` — weather radar domes at golden hour by David Stroia
  (https://unsplash.com/@quebek), /apps.
- `govcon-radar-dish.webp` — radio dish under the Milky Way by Stephan Widua
  (https://unsplash.com/@stewi), /apps/govcon-radar. Both are vendored from
  the GovCon Radar site so the two properties read as one brand.
- `note-ledger.webp` — old handwritten ledger by camera obscura
  (https://unsplash.com/photos/rvVhr2LngP4), the cost field note.
- `note-mailboxes.webp` — rural mailboxes by Tolga Ahmetler
  (https://unsplash.com/photos/o_XfzXGPaiM), the migration field note.
- `note-switchbacks.webp` — dusk switchbacks with taillights by Luke Miller
  (https://unsplash.com/photos/PGCw9boMJQM), the GenAI guardrails field note.

Not Unsplash: `trevor-lewis.webp` (640x651 ≈ 22 KB) on /about is the owner's
own headshot, so it carries no photo credit in the footer.

Also not Unsplash, and not credited in a footer either: the three GovCon Radar
screenshots (`govcon-radar-matches|brief|pipeline.webp`, 640px wide WebP made
with `cwebp -q 80 -resize 640 0` from the iOS store assets in
`~/Developer/govcon-radar/docs/store-assets/ios/`) are our own product's
screens, and `assets/badges/` holds Apple's and Google's official store badges,
whose trademark attribution sits in the visible disclaimer on
/apps/govcon-radar. Re-export the screenshots from the store assets whenever
the app's UI changes, so the page never shows a screen the app no longer has.

Two document downloads also live in `site/assets/`:

- `Trevor_Lewis_Resume.pdf` — the PUBLIC resume variant, linked from /about.
  Built by `Projects/Trevor Resume/web-resume/build_resume.py` (same
  fonts/mark/pipeline as the capability statement build). It deliberately
  differs from the private resumes in that folder: the current employer is
  never named, the enterprise role carries no dates, and figures come from
  the capability statement's FACTS base. Regenerate there, then re-copy.
- `Planetek_Capability_Statement_Federal.pdf` — verbatim copy of the shipped
  Federal variant from `Projects/Planetek Documents/CapabilityStatement/`,
  linked from /federal and the homepage federal strip. When the statement is
  rebuilt, re-copy it here, and check the "Try it right now" section on
  /federal: it mirrors the statement's four numbered evaluator actions
  word for word (added 2026-08-05), so a change to that list in the PDF
  means the same change on the page.
- `Planetek_Teaming_One-Pager.pdf` — the single-sheet teaming cut of the
  capability statement (variant `teaming` in the same build), linked from
  the /federal registrations section for prime and partner outreach. Same
  re-copy rule when rebuilt.

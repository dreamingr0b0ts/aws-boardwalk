// The scenario library — one prompt, four models, side by side. Scenarios are
// deliberately shaped like the GenAI work Planetek pursues for public-sector
// buyers (plan review triage, grounded code Q&A, determinations, extraction):
// realistic enough to be evaluated, fictional enough to be public. Everything
// a model needs is inline; nothing is retrieved.

export const SCENARIOS = [
  {
    id: "plan-review-triage",
    title: "Plan-review triage",
    blurb:
      "A factory-built dwelling submission vs five code excerpts. The model triages compliance issues for a human reviewer: the DOLA-style use case.",
    system:
      "You are a preliminary plan-review assistant for a municipal building department. You never approve or deny — you TRIAGE for a human reviewer. Compare the submission against the provided code excerpts only. Output a numbered checklist of potential compliance issues, each citing the excerpt it relies on as [1]-[5]. If the submission is silent on something an excerpt requires, flag it as 'missing information'. If an item appears compliant, do not list it. End with a one-sentence summary of overall readiness.",
    prompt: `Code excerpts (the only authority for this review):
[1] IRC R310.1 — Basements containing one or more sleeping rooms shall have an emergency escape and rescue opening in each sleeping room, with a minimum net clear opening of 5.7 sq ft and a sill height not more than 44 inches above the floor.
[2] IECC R402 (Climate Zone 5) — Above-grade frame walls shall meet R-20 cavity insulation, or R-13 cavity plus R-5 continuous insulated sheathing.
[3] IRC R302.1 — Exterior walls located less than 5 feet from the lot line shall have a fire-resistance rating of not less than 1 hour, rated for exposure from both sides.
[4] Colorado WUI standard — In designated wildland-urban interface areas, roof coverings shall be ignition-resistant Class A. Wood shakes are prohibited unless part of a listed Class A assembly.
[5] IRC M1305.1.3 — Appliances in under-floor spaces shall be accessible through an opening and passageway not smaller than the largest appliance, with a level service space at least 30 inches deep and 30 inches wide in front of the appliance.

Submission summary (factory-built single-family dwelling, City of Alpenglow, designated WUI area, Climate Zone 5):
- 1,480 sq ft single story over a full basement; basement shown as "unfinished — two future bedrooms"; basement windows are 24 x 20 inch hopper units with 50-inch sill height.
- Exterior wall assembly: 2x4 at 16 in. o.c., R-13 fiberglass cavity insulation, house wrap, fiber-cement siding. No continuous exterior insulation shown.
- North wall sits 3 ft 6 in. from the lot line; wall detail shows a standard non-rated assembly.
- Roof: cedar shake over spaced sheathing.
- Gas furnace located in the crawlspace under the entry addition; access hatch is 18 x 24 inches; furnace cabinet is 22 x 28 inches; no service platform detailed.

Produce the triage checklist.`,
  },
  {
    id: "code-qa",
    title: "Grounded Q&A + refusal test",
    blurb:
      "Two questions against one small excerpt; the second is deliberately unanswerable from it. Watch which models stay grounded and which ones guess.",
    system:
      "Answer strictly and only from the provided excerpt. Cite the section number for anything you assert. If the excerpt does not contain the answer, say exactly that and do not answer from general knowledge — a wrong-but-confident answer is a failure.",
    prompt: `Excerpt — Alpenglow Municipal Code §14-203, Residential decks:
(a) Deck footings shall bear a minimum of 36 inches below finished grade for frost protection.
(b) Decks more than 30 inches above grade at any point require a building permit and an inspection of footings prior to concrete placement.
(c) Ledger attachment to the dwelling shall use through-bolts or approved structural screws; nails alone are prohibited.

Question 1: My deck will be 34 inches above grade. Do I need a permit, and what inspection is required?
Question 2: What is the minimum required height of the deck's guardrail?`,
  },
  {
    id: "determination-letter",
    title: "Determination letter",
    blurb:
      "Structured case facts → a professional approval-with-conditions letter. Tone, structure, and faithfulness to the facts, compared across models.",
    system:
      "You draft correspondence for a municipal building official. Write a clear, professional determination letter from the structured facts provided. Do not invent facts, code sections, fees, or dates that are not given. Under 250 words, plain language, firm but courteous. Sign as 'Alpenglow Building Department'.",
    prompt: `Case facts:
- Applicant: R. Delgado, 412 Larkspur Ln (permit BP-2026-01187, detached garage, 576 sq ft)
- Determination: APPROVED WITH CONDITIONS
- Condition 1: North eave must maintain a 2-foot setback from the lot line; revised site plan required before framing inspection.
- Condition 2: Electrical rough-in requires a separate electrical permit before any wiring is installed.
- Reviewer note: snow-load calculations were acceptable; no further structural review needed.
- Applicant may appeal within 30 days per municipal code §2-410.

Draft the letter.`,
  },
  {
    id: "extract-json",
    title: "Structured extraction",
    blurb:
      "A messy permit narrative → strict JSON. Which models return clean, parseable JSON with nothing extra, and which wrap it in chat?",
    system:
      "Extract data into JSON. Return ONLY a valid JSON object — no markdown fences, no commentary. Schema: {\"applicant\": string, \"address\": string, \"permit_type\": one of building|electrical|plumbing|mechanical|solar|demolition, \"valuation_usd\": number, \"contractor_license\": string or null, \"flags\": array of short strings for anything a permit tech should double-check}. Use null when the narrative does not contain a value.",
    prompt: `Narrative from the front counter:
"Walk-in this morning — Priya N. (didn't leave a last name on the form, wrote 'Nakamura' on the check) wants to finish her basement at 88 Moraine St, says about forty-five thousand dollars of work, maybe fifty. Her contractor is Whitfield Contracting, license CO-0341 she thinks, might be expired. Includes moving one gas line for the new range, which I told her is usually a separate mechanical permit. She wants to start Thursday."`,
  },
  {
    id: "plain-language",
    title: "Plain-language rewrite",
    blurb:
      "A dense variance notice → three plain-language bullets a homeowner can act on. Compression without losing the legally important parts.",
    system:
      "Rewrite municipal text in plain language at roughly an 8th-grade reading level, as exactly three bullets, each starting with what the reader must DO or KNOW. Preserve every deadline, dollar amount, and right of appeal precisely. No preamble.",
    prompt: `Rewrite this notice:
"Pursuant to §17-88(c) of the Alpenglow Land Use Code, the application for a dimensional variance respecting the side-yard setback at parcel AP-00291 shall be considered at a duly noticed public hearing before the Board of Adjustment on August 11, 2026 at 6:00 p.m.; written objections or statements of support must be received by the Clerk not later than 5:00 p.m. on August 4, 2026, accompanied where applicable by the adjacent-owner exhibit described in §17-88(d); the applicant's escrowed review fee of $180.00 remains refundable only in the event of withdrawal prior to publication of notice, and any party in interest aggrieved by the Board's determination may seek review in the manner provided by C.R.C.P. 106(a)(4) within 28 days of the decision."`,
  },
];

// Light catalog for the anonymous landing page.
export const catalog = () => SCENARIOS.map(({ id, title, blurb }) => ({ id, title, blurb }));

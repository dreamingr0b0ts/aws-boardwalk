// The visitor question library. Visitors (no sign-in) may ONLY ask these:
// the id is the API contract, and nothing a stranger types ever reaches a
// model — the same fence the Model Workbench visitor tier uses. Questions
// span every corpus document, plus one deliberately off-corpus question so
// visitors can watch the assistant decline instead of guess.

export interface CuratedQuestion {
  id: string;
  label: string; // short chip text shown in the UI
  question: string; // the full question sent through the RAG pipeline
  offCorpus?: boolean; // marks the refusal exhibit
}

export const QUESTIONS: CuratedQuestion[] = [
  {
    id: 'deck-cost',
    label: 'Deck permit cost',
    question: 'How much does a residential deck permit cost, and what does it include?',
  },
  {
    id: 'water-heater',
    label: 'Water heater swap',
    question: 'Do I need a permit to replace my water heater with the same kind of unit?',
  },
  {
    id: 'no-permit',
    label: 'Work with no permit',
    question: 'What kinds of home projects do not require a permit at all?',
  },
  {
    id: 'review-time',
    label: 'Review timelines',
    question: 'How long does the city take to review a standard residential permit?',
  },
  {
    id: 'permit-fees',
    label: 'How fees are set',
    question: 'How are building permit fees calculated?',
  },
  {
    id: 'str-cap',
    label: 'Short-term rentals',
    question: 'Are short-term rental licenses capped in Alpenglow, and does it matter if I live in the home?',
  },
  {
    id: 'home-business',
    label: 'Home business license',
    question: 'Does a home-based business need a city business license?',
  },
  {
    id: 'own-permit',
    label: 'Homeowner permits',
    question: 'Can a homeowner pull their own permit without registering as a contractor?',
  },
  {
    id: 'inspection',
    label: 'Scheduling inspections',
    question: 'How do I schedule an inspection, and can I get one the same day?',
  },
  {
    id: 'zoning-r1',
    label: 'R-1 zoning rules',
    question: 'What are the setbacks and height limit in the R-1 single-family district?',
  },
  {
    id: 'appeal',
    label: 'Appealing a denial',
    question: 'How do I appeal a permit denial, and which board hears the appeal?',
  },
  {
    id: 'off-corpus',
    label: 'Watch it decline',
    question: 'What are the parking rules in downtown Denver?',
    offCorpus: true,
  },
];

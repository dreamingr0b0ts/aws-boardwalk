// Generates the seed corpus: eight fictional City of Alpenglow documents that
// exercise every pipeline stage (form key/values for Textract FORMS, names and
// dates and amounts for Comprehend, distinct genres for the Bedrock
// classifier), plus one over-the-page-cap fixture used by verify.sh to prove
// the rejection guard. PDFs land in ./pdfs (gitignored); `make seed` uploads
// everything not starting with "_" through the live pipeline.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'pdfs');
mkdirSync(OUT, { recursive: true });

const INK = rgb(0.11, 0.1, 0.09);
const MUTED = rgb(0.42, 0.4, 0.38);
const PINE = rgb(0.086, 0.19, 0.18);

async function makeDoc() {
  const pdf = await PDFDocument.create();
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  return { pdf, fonts };
}

function pageWriter(pdf, fonts, heading, subheading) {
  const page = pdf.addPage([612, 792]); // US Letter
  let y = 740;

  page.drawText('CITY OF ALPENGLOW, COLORADO', { x: 54, y, size: 10, font: fonts.bold, color: PINE });
  y -= 14;
  page.drawText('Fictional demonstration document — Planetek AWS Boardwalk', {
    x: 54, y, size: 8, font: fonts.regular, color: MUTED,
  });
  y -= 34;
  page.drawText(heading, { x: 54, y, size: 17, font: fonts.bold, color: INK });
  y -= 16;
  if (subheading) {
    page.drawText(subheading, { x: 54, y, size: 10, font: fonts.regular, color: MUTED });
    y -= 12;
  }
  y -= 14;

  const w = {
    page,
    /** "Label:   value" rows — the shape Textract FORMS reads as key/value pairs. */
    field(label, value, indent = 54) {
      page.drawText(`${label}:`, { x: indent, y, size: 10.5, font: fonts.bold, color: INK });
      page.drawText(String(value), { x: indent + 175, y, size: 10.5, font: fonts.regular, color: INK });
      y -= 19;
      return w;
    },
    text(line, size = 10.5, font = fonts.regular) {
      page.drawText(line, { x: 54, y, size, font, color: INK });
      y -= size + 6;
      return w;
    },
    heading(line) {
      y -= 8;
      page.drawText(line, { x: 54, y, size: 12, font: fonts.bold, color: PINE });
      y -= 20;
      return w;
    },
    gap(n = 12) {
      y -= n;
      return w;
    },
  };
  return w;
}

async function save(pdf, name) {
  writeFileSync(join(OUT, name), await pdf.save());
  console.log(`  ${name}`);
}

// ---- 1. building permit application (permit-application) -------------------

async function permitApplication() {
  const { pdf, fonts } = await makeDoc();
  const w = pageWriter(pdf, fonts, 'Building Permit Application', 'Community Development Department · Form BP-1');
  w.field('Permit Number', 'BP-2026-0417')
    .field('Date Filed', 'June 12, 2026')
    .field('Applicant Name', 'Maria Santos-Rivera')
    .field('Property Address', '1420 Alpenglow Way, Alpenglow, CO 80499')
    .field('Parcel ID', 'R-338-104-22')
    .field('Project Type', 'Residential deck addition')
    .field('Project Valuation', '$48,500.00')
    .field('Contractor', 'Summit Ridge Builders LLC')
    .field('Contractor License No', 'GC-11-2087')
    .field('Contractor Phone', '(970) 555-0144')
    .heading('Description of Work')
    .text('Construct a 320 sq ft attached cedar deck with hot tub reinforcement at the rear')
    .text('elevation, including new footings, guardrails per IRC R312, and one exterior')
    .text('receptacle. Work to be completed by September 30, 2026.')
    .heading('Certification')
    .text('I certify that the information above is true and correct and that all work will')
    .text('comply with the Alpenglow Municipal Code, Title 15.')
    .gap()
    .field('Applicant Signature', 'Maria Santos-Rivera')
    .field('Plan Review Fee Paid', '$212.00');
  await save(pdf, 'building-permit-application.pdf');
}

// ---- 2. electrical inspection report (inspection-report) -------------------

async function inspectionReport() {
  const { pdf, fonts } = await makeDoc();
  const w = pageWriter(pdf, fonts, 'Electrical Inspection Report', 'Building Safety Division · Field Report');
  w.field('Inspection ID', 'INS-2026-1189')
    .field('Permit Number', 'BP-2026-0417')
    .field('Inspection Date', 'June 20, 2026')
    .field('Inspector', 'Dana Kowalski, Cert. E-441')
    .field('Site Address', '1420 Alpenglow Way, Alpenglow, CO 80499')
    .field('Inspection Type', 'Rough electrical')
    .heading('Checklist')
    .field('Grounding and bonding', 'Pass', 72)
    .field('GFCI protection at exterior', 'Pass', 72)
    .field('Conductor sizing (NEC 310)', 'Pass', 72)
    .field('Box fill calculations', 'Pass', 72)
    .field('Weatherproof covers', 'Corrected on site', 72)
    .heading('Result')
    .field('Overall Result', 'PASS')
    .field('Reinspection Required', 'No')
    .text('Exterior receptacle cover replaced during inspection; no further action required.')
    .gap()
    .field('Inspector Signature', 'D. Kowalski')
    .field('Next Inspection', 'Final — call (970) 555-0121 to schedule');
  await save(pdf, 'electrical-inspection-report.pdf');
}

// ---- 3. business license certificate (license-certificate) -----------------

async function businessLicense() {
  const { pdf, fonts } = await makeDoc();
  const w = pageWriter(pdf, fonts, 'Business License Certificate', 'Office of the City Clerk');
  w.text('This certifies that the business named below is licensed to operate within the')
    .text('City of Alpenglow, subject to the Alpenglow Municipal Code, Title 5.')
    .gap()
    .field('License Number', 'BL-2026-0733')
    .field('Business Name', 'The Timberline Cafe')
    .field('Owner', 'Priya Desai')
    .field('Business Address', '212 Larkspur Street, Alpenglow, CO 80499')
    .field('License Type', 'Food Service Establishment — Class B')
    .field('Seating Capacity', '46')
    .field('Date Issued', 'January 15, 2026')
    .field('Expiration Date', 'January 14, 2027')
    .field('Annual Fee Paid', '$185.00')
    .heading('Conditions')
    .text('This license is not transferable. It must be displayed in a conspicuous location')
    .text('at the licensed premises. Health inspections are conducted by Ridgeline County')
    .text('Public Health under the 2026 interagency agreement.')
    .gap()
    .field('City Clerk', 'Jordan Ellison');
  await save(pdf, 'business-license-certificate.pdf');
}

// ---- 4. contractor invoice (invoice) — verify.sh checks the total ----------

async function contractorInvoice() {
  const { pdf, fonts } = await makeDoc();
  const w = pageWriter(pdf, fonts, 'Invoice', 'Alpenridge Concrete & Flatwork · 88 Quarry Road, Alpenglow, CO 80499');
  w.field('Invoice Number', 'ARC-2214')
    .field('Invoice Date', 'July 1, 2026')
    .field('Due Date', 'July 31, 2026')
    .field('Bill To', 'City of Alpenglow — Public Works Department')
    .field('Attention', 'Sam Whitefeather, Streets Superintendent')
    .field('Project', 'Curb and gutter repair, Larkspur Street blocks 200-300')
    .heading('Line Items')
    .field('Remove and replace curb (64 lf)', '$1,088.00', 72)
    .field('Sidewalk panel replacement (3 ea)', '$462.00', 72)
    .field('Traffic control (1 day)', '$144.00', 72)
    .heading('Totals')
    .field('Subtotal', '$1,694.00')
    .field('Sales Tax (8.77%)', '$148.50')
    .field('Total Due', '$1,842.50')
    .gap()
    .text('Terms: Net 30. Please reference invoice number ARC-2214 on payment.')
    .text('Remit to: Alpenridge Concrete & Flatwork, 88 Quarry Road, Alpenglow, CO 80499.');
  await save(pdf, 'contractor-invoice.pdf');
}

// ---- 5. code violation notice (violation-notice) ----------------------------

async function violationNotice() {
  const { pdf, fonts } = await makeDoc();
  const w = pageWriter(pdf, fonts, 'Notice of Municipal Code Violation', 'Code Compliance Division');
  w.field('Case Number', 'CE-2026-0288')
    .field('Notice Date', 'June 25, 2026')
    .field('Property Owner', 'Theodore Brandt')
    .field('Property Address', '77 Juniper Court, Alpenglow, CO 80499')
    .field('Violation', 'Overgrown vegetation exceeding 12 inches')
    .field('Code Section', 'AMC 8.12.040(B)')
    .field('Compliance Deadline', 'July 16, 2026')
    .heading('Details')
    .text('An inspection on June 24, 2026 found grasses and weeds exceeding twelve inches in')
    .text('height across the front and side yards. Please cut and maintain all vegetation')
    .text('below twelve inches. If the property is not brought into compliance by the')
    .text('deadline, the City may abate the violation and assess costs plus a $150')
    .text('administrative fee against the property.')
    .heading('Questions or Appeal')
    .text('Contact Code Compliance Officer Rosa Delgado at (970) 555-0167 within 10 days to')
    .text('discuss this notice or request an administrative hearing under AMC 1.20.')
    .gap()
    .field('Issued By', 'Rosa Delgado, Code Compliance Officer');
  await save(pdf, 'code-violation-notice.pdf');
}

// ---- 6. planning commission minutes (meeting-minutes, 2 pages) -------------

async function meetingMinutes() {
  const { pdf, fonts } = await makeDoc();
  const w = pageWriter(pdf, fonts, 'Planning Commission — Meeting Minutes', 'Regular Session · Council Chambers');
  w.field('Meeting Date', 'June 3, 2026')
    .field('Called to Order', '6:02 PM')
    .field('Adjourned', '8:14 PM')
    .field('Members Present', 'Chen (Chair), Okafor, Lindqvist, Baca, Werner')
    .field('Members Absent', 'None')
    .field('Staff', 'A. Fontaine (Planning Director), M. Reyes (Recording Secretary)')
    .heading('Agenda Item 1 — Timberline Cafe patio expansion (CUP-2026-04)')
    .text('Applicant Priya Desai presented a conditional use permit request for a 12-table')
    .text('sidewalk patio at 212 Larkspur Street. Two residents spoke regarding evening')
    .text('noise. Commissioner Okafor moved to approve with a 9:00 PM outdoor service')
    .text('curfew; seconded by Lindqvist. Motion carried 5-0.')
    .heading('Agenda Item 2 — Alpenglow Way corridor rezoning study')
    .text('Director Fontaine summarized the consultant scope for the corridor study,')
    .text('estimated at $62,000, funded from the 2026 long-range planning budget. The')
    .text('Commission directed staff to issue the RFP by July 15, 2026.');
  const w2 = pageWriter(pdf, fonts, 'Planning Commission Minutes — Page 2', 'Regular Session, June 3, 2026 (continued)');
  w2.heading('Agenda Item 3 — Short-term rental cap review')
    .text('Staff reported 118 licensed short-term rentals against the current cap of 125.')
    .text('Commissioner Baca moved to recommend Council hold the cap at 125 for 2027;')
    .text('seconded by Werner. Motion carried 4-1 with Chen opposed.')
    .heading('Adjournment')
    .text('There being no further business, Chair Chen adjourned the meeting at 8:14 PM.')
    .gap()
    .field('Approved', 'July 1, 2026')
    .field('Recording Secretary', 'M. Reyes');
  await save(pdf, 'planning-commission-minutes.pdf');
}

// ---- 7. STR permit renewal letter (correspondence) --------------------------

async function renewalLetter() {
  const { pdf, fonts } = await makeDoc();
  const w = pageWriter(pdf, fonts, 'Short-Term Rental Permit Renewal', 'Office of the City Clerk · Correspondence');
  w.field('Date', 'June 30, 2026')
    .field('Permit Number', 'STR-0042')
    .field('Property', '9 Bristlecone Lane, Alpenglow, CO 80499')
    .gap()
    .text('Dear Mr. Okafor,')
    .gap(4)
    .text('Your short-term rental permit STR-0042 expires on August 15, 2026. To renew for')
    .text('the 2026-2027 season, please submit the renewal application, the $240 renewal')
    .text('fee, and a current proof of liability insurance (minimum $1,000,000) no later')
    .text('than August 1, 2026.')
    .gap(4)
    .text('Renewals received after August 1 incur a $60 late fee; permits not renewed by')
    .text('the expiration date are released to the waitlist under AMC 5.90.070. Occupancy')
    .text('remains limited to eight guests, and the local responsible party on file must')
    .text('be reachable within 60 minutes.')
    .gap(4)
    .text('You can submit everything online at permits.demos.planetek.org or in person at')
    .text('City Hall, 100 Summit Plaza, weekdays 8:00 AM to 5:00 PM.')
    .gap(4)
    .text('Sincerely,')
    .gap(2)
    .text('Jordan Ellison')
    .text('City Clerk, City of Alpenglow')
    .text('(970) 555-0102 · clerk@alpenglow-co.example.gov');
  await save(pdf, 'str-renewal-letter.pdf');
}

// ---- 8. contractor registration (permit-application/other form) -------------

async function contractorRegistration() {
  const { pdf, fonts } = await makeDoc();
  const w = pageWriter(pdf, fonts, 'Contractor Registration Form', 'Community Development Department · Form CR-2');
  w.field('Registration Number', 'CR-2026-0512')
    .field('Registration Date', 'May 8, 2026')
    .field('Company Name', 'Summit Ridge Builders LLC')
    .field('Trade Classification', 'General Contractor — Class B')
    .field('Principal', 'Elena Vasquez')
    .field('Business Address', '415 Old Mill Road, Ridgeline, CO 80498')
    .field('Phone', '(970) 555-0144')
    .field('State License No', 'GC-11-2087')
    .field('Insurance Carrier', 'Continental Divide Mutual')
    .field('Policy Number', 'CDM-88-104477')
    .field('Liability Limit', '$2,000,000 aggregate')
    .field('Policy Expiration', 'May 1, 2027')
    .field('Workers Comp Carrier', 'Pinnacol Assurance')
    .heading('Attestation')
    .text('The undersigned attests that the information provided is accurate and agrees to')
    .text('maintain required insurance for the duration of all permitted work in the City')
    .text('of Alpenglow.')
    .gap()
    .field('Signature', 'Elena Vasquez')
    .field('Registration Fee Paid', '$95.00');
  await save(pdf, 'contractor-registration.pdf');
}

// ---- verify fixture: 7 pages, over the 6-page cap ---------------------------

async function overLimitFixture() {
  const { pdf, fonts } = await makeDoc();
  for (let i = 1; i <= 7; i++) {
    pageWriter(pdf, fonts, `Corridor Study Appendix — Page ${i} of 7`, 'Oversized fixture used to verify the page-cap rejection')
      .text('This document intentionally exceeds the demo page cap so the verify suite can')
      .text('prove that oversized documents are rejected before any OCR spend occurs.');
  }
  await save(pdf, '_over-page-limit.pdf');
}

console.log('generating seed corpus →', OUT);
await permitApplication();
await inspectionReport();
await businessLicense();
await contractorInvoice();
await violationNotice();
await meetingMinutes();
await renewalLetter();
await contractorRegistration();
await overLimitFixture();
console.log('done');

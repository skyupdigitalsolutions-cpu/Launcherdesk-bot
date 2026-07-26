// ─────────────────────────────────────────────────────────────
//  LauncherDesk — Declarative Flow Definitions (Phase 1)
//  Source of truth: "LauncherDesk AI Bot Flow — Phase 1
//  Developer Document FINAL (2)"
//
//  WHY DECLARATIVE:
//  8 categories x ~6 steps = ~50 questions. Hard-coding these as
//  switch cases is unmaintainable — the client will change wording
//  weekly. Everything lives here as data; flowEngine.js executes it.
//  To change a question, edit this file only. No engine changes.
//
//  WHATSAPP HARD LIMITS baked into these definitions:
//   - Reply buttons: max 3, title <= 20 chars
//   - List rows: max 10 TOTAL across all sections, title <= 24 chars,
//     description <= 72 chars
//   - No native multi-select (see input:'multi' for the workaround)
//
//  STEP SHAPE:
//   key        unique field name, stored in session.answers[key]
//   label      human label used on the summary card
//   prompt     the question text sent to the user
//   input      'list' | 'buttons' | 'text' | 'multi'
//   options    [{ id, title, description? }]  (list/buttons/multi)
//   required   false => user gets a Skip control
//   validate   'mobile' | 'email' | 'name' | 'city' | 'free'
//   skipIf     fn(answers) => true to skip this step entirely
//   branchTo   fn(value) => flowId, hands off to another flow
//   listButton CTA label on the list widget (<= 20 chars)
// ─────────────────────────────────────────────────────────────

// Reused across marketplace buyer/seller paths
const TOOL_CATEGORIES = [
  { id: 'crm',        title: 'CRM',                 description: 'Customer relationship management' },
  { id: 'clm',        title: 'CLM',                 description: 'Contract lifecycle management' },
  { id: 'accounting', title: 'Accounting & Finance', description: 'Books, invoicing, tax software' },
  { id: 'hr',         title: 'HR & Payroll',        description: 'Hiring, attendance, salary' },
  { id: 'pm',         title: 'Project Management',  description: 'Tasks, sprints, collaboration' },
  { id: 'marketing',  title: 'Marketing & SEO',     description: 'Campaigns, SEO, analytics' },
  { id: 'itcloud',    title: 'IT & Cloud Tools',    description: 'Hosting, security, DevOps' },
];

// ── Standard closing steps (name + mobile) ────────────────────
// Mobile is PRE-FILLED from the WhatsApp number and confirmed with
// a button instead of re-typed. The doc asks for a mobile number;
// asking a user to type the number they are already messaging from
// is the single biggest drop-off point in a WhatsApp flow. Tapping
// "Yes, use this" satisfies the requirement in one tap, and
// "Use another number" still gives the typed-entry path with the
// doc's 10-digit validation.
const STEP_NAME = {
  key: 'name',
  label: 'Name',
  prompt: "What's your name?",
  input: 'text',
  required: true,
  validate: 'name',
};

const STEP_MOBILE = {
  key: 'mobile',
  label: 'Mobile Number',
  // Doc §2–§9 wording, verbatim. The pre-fill confirmation below is a
  // UX adaptation, but the question the user reads is exactly the
  // doc's — there was no reason to reword it as well.
  prompt: "What's your mobile number?",
  input: 'mobile_confirm',
  required: true,
  validate: 'mobile',
};

const FLOWS = {

  // ═══════════════════════════════════════════════════════════
  //  2. Business Registration
  // ═══════════════════════════════════════════════════════════
  biz_reg: {
    id: 'biz_reg',
    label: 'Business Registration',
    menu: { title: 'Business Registration', description: 'Pvt Ltd, LLP, OPC, NGO & more' },
    steps: [
      {
        key: 'entity_type',
        label: 'Registration Type',
        prompt: 'What would you like to register?',
        input: 'list',
        listButton: 'Choose Type',
        required: true,
        options: [
          { id: 'pvt_ltd',     title: 'Private Limited Co.',   description: 'Most common for startups' },
          { id: 'llp',         title: 'LLP',                   description: 'Limited Liability Partnership' },
          { id: 'opc',         title: 'OPC',                   description: 'One Person Company' },
          { id: 'partnership', title: 'Partnership Firm',      description: 'Two or more partners' },
          { id: 'proprietor',  title: 'Proprietorship',        description: 'Single owner, simplest setup' },
          { id: 'ngo',         title: 'NGO / Trust',           description: 'Section 8, Trust or Society' },
          // Doc title "DPIIT / Startup India Recognition" is 33 chars.
          // Trimmed to fit the 24-char list limit; full wording moved
          // into the description so nothing is lost for the user.
          { id: 'dpiit',       title: 'DPIIT / Startup India', description: 'Startup India Recognition' },
          { id: 'not_sure',    title: 'Not Sure',              description: 'Help me decide' },
        ],
      },
      {
        key: 'business_stage',
        label: 'Stage',
        prompt: 'Is this a new business or already registered?',
        input: 'buttons',
        required: true,
        // Doc logic note: DPIIT recognition only applies to an
        // already-incorporated business, so this question is
        // meaningless on that path.
        skipIf: (a) => a.entity_type === 'dpiit',
        options: [
          { id: 'new',       title: 'New Business' },
          { id: 'existing',  title: 'Already Registered' },
        ],
      },
      {
        key: 'city',
        label: 'City',
        prompt: 'Which city will your business operate from?',
        input: 'text',
        required: true,
        validate: 'city',
      },
      {
        key: 'addons',
        label: 'Additional Services',
        prompt: 'Would you also like assistance with any of these?',
        input: 'multi',
        listButton: 'Select Services',
        required: false,
        options: [
          { id: 'gst',        title: 'GST',             description: 'GST registration' },
          { id: 'msme',       title: 'MSME',            description: 'Udyam / MSME certificate' },
          { id: 'trademark',  title: 'Trademark',       description: 'Brand name protection' },
          { id: 'current_ac', title: 'Current Account', description: 'Business bank account' },
          { id: 'virtual_of', title: 'Virtual Office',  description: 'Registered office address' },
        ],
      },
      STEP_NAME,
      STEP_MOBILE,
    ],
  },

  // ═══════════════════════════════════════════════════════════
  //  3. Licenses & Certifications
  // ═══════════════════════════════════════════════════════════
  licenses: {
    id: 'licenses',
    label: 'Licenses & Certifications',
    menu: { title: 'Licenses & Certs', description: 'GST, MSME, FSSAI, ISO & more' },
    steps: [
      {
        key: 'license_type',
        label: 'Service',
        prompt: 'Which service do you need?',
        input: 'list',
        listButton: 'Choose Service',
        required: true,
        options: [
          { id: 'gst',     title: 'GST',           description: 'Goods & Services Tax' },
          { id: 'msme',    title: 'MSME',          description: 'Udyam registration' },
          { id: 'fssai',   title: 'FSSAI',         description: 'Food business license' },
          { id: 'iso',     title: 'ISO',           description: 'ISO certification' },
          { id: 'iec',     title: 'IEC',           description: 'Import Export Code' },
          { id: 'shop',    title: 'Shop License',  description: 'Shops & Establishment' },
          { id: 'trade',   title: 'Trade License', description: 'Municipal trade license' },
          { id: 'other',   title: 'Other',         description: 'Something else' },
        ],
      },
      {
        key: 'request_type',
        label: 'Request Type',
        prompt: 'Is this a new registration, renewal, or modification?',
        input: 'buttons',
        required: true,
        options: [
          { id: 'new',          title: 'New Registration' },
          { id: 'renewal',      title: 'Renewal' },
          { id: 'modification', title: 'Modification' },
        ],
      },
      {
        key: 'city',
        label: 'City',
        prompt: 'Which city is your business based in?',
        input: 'text',
        required: true,
        validate: 'city',
      },
      {
        key: 'business_name',
        label: 'Business Name',
        prompt: "What's your business name?",
        input: 'text',
        required: false,
        validate: 'free',
      },
      STEP_NAME,
      STEP_MOBILE,
    ],
  },

  // ═══════════════════════════════════════════════════════════
  //  4. Finance & Accounts
  // ═══════════════════════════════════════════════════════════
  finance: {
    id: 'finance',
    label: 'Finance & Accounts',
    menu: { title: 'Finance & Accounts', description: 'Bookkeeping, GST filing, Payroll' },
    steps: [
      {
        key: 'finance_service',
        label: 'Service',
        prompt: 'Which service do you need?',
        input: 'list',
        listButton: 'Choose Service',
        required: true,
        options: [
          { id: 'gst_filing',  title: 'GST Filing',        description: 'Monthly / quarterly returns' },
          { id: 'itr',         title: 'Income Tax Return',  description: 'ITR filing' },
          { id: 'bookkeeping', title: 'Bookkeeping',        description: 'Day-to-day accounting' },
          { id: 'payroll',     title: 'Payroll',            description: 'Salary & compliance' },
          { id: 'audit',       title: 'Audit',              description: 'Statutory & internal audit' },
          { id: 'cfo',         title: 'CFO Services',       description: 'Virtual CFO advisory' },
        ],
      },
      {
        key: 'business_type',
        label: 'Business Type',
        prompt: "What's your business type?",
        input: 'list',
        listButton: 'Choose Type',
        required: true,
        options: [
          { id: 'individual', title: 'Individual',  description: 'Salaried or personal' },
          { id: 'proprietor', title: 'Proprietor',  description: 'Sole proprietorship' },
          { id: 'company',    title: 'Company',     description: 'Pvt Ltd / Ltd' },
          { id: 'llp',        title: 'LLP',         description: 'Limited Liability Partnership' },
        ],
      },
      {
        key: 'city',
        label: 'City',
        prompt: 'Which city are you in?',
        input: 'text',
        required: true,
        validate: 'city',
      },
      STEP_NAME,
      STEP_MOBILE,
    ],
  },

  // ═══════════════════════════════════════════════════════════
  //  5. IT Services
  // ═══════════════════════════════════════════════════════════
  it_services: {
    id: 'it_services',
    label: 'IT Services',
    menu: { title: 'IT Services', description: 'Website, Ecommerce, ERP, Cloud' },
    steps: [
      {
        key: 'it_need',
        label: 'Requirement',
        prompt: 'What do you need?',
        input: 'list',
        listButton: 'Choose Service',
        required: true,
        // 9 options + Back = exactly 10 rows, the WhatsApp maximum.
        // The engine drops the "Start Over" row here automatically;
        // typing RESTART still works.
        options: [
          { id: 'website',    title: 'Website',            description: 'Business or portfolio site' },
          { id: 'ecommerce',  title: 'Ecommerce Website',  description: 'Online store' },
          { id: 'mobile_app', title: 'Mobile App',         description: 'Android / iOS' },
          { id: 'erp',        title: 'ERP',                description: 'Enterprise resource planning' },
          { id: 'crm',        title: 'CRM',                description: 'Customer management' },
          { id: 'clm',        title: 'Smart CLM',          description: 'Contract lifecycle' },
          { id: 'digital_mkt',title: 'Digital Marketing',  description: 'Ads, social, content' },
          { id: 'seo',        title: 'SEO',                description: 'Search rankings' },
          { id: 'hosting',    title: 'Cloud Hosting',      description: 'Servers & hosting' },
        ],
      },
      {
        key: 'has_business',
        label: 'Registered Business',
        prompt: 'Do you already have a registered business?',
        input: 'buttons',
        required: true,
        options: [
          { id: 'yes', title: 'Yes' },
          { id: 'no',  title: 'No' },
        ],
      },
      {
        key: 'business_name',
        label: 'Business Name',
        prompt: "What's your business name?",
        input: 'text',
        required: false,
        validate: 'free',
        // Pointless to ask if they just said they have no business.
        skipIf: (a) => a.has_business === 'no',
      },
      {
        key: 'city',
        label: 'City',
        prompt: 'Which city are you in?',
        input: 'text',
        required: true,
        validate: 'city',
      },
      STEP_NAME,
      STEP_MOBILE,
    ],
  },

  // ═══════════════════════════════════════════════════════════
  //  6. Legal & Compliance
  // ═══════════════════════════════════════════════════════════
  legal: {
    id: 'legal',
    label: 'Legal & Compliance',
    menu: { title: 'Legal & Compliance', description: 'Trademark, ROC, Labour Law' },
    steps: [
      {
        key: 'legal_service',
        label: 'Service',
        prompt: 'Which service do you need?',
        input: 'list',
        listButton: 'Choose Service',
        required: true,
        options: [
          { id: 'trademark',   title: 'Trademark',           description: 'Brand registration' },
          { id: 'roc',         title: 'ROC Filing',          description: 'Registrar of Companies' },
          { id: 'labour',      title: 'Labour Compliance',   description: 'PF, ESI, labour laws' },
          { id: 'annual',      title: 'Company Annual Filing', description: 'Yearly ROC compliance' },
          { id: 'agreement',   title: 'Agreement Drafting',  description: 'Contracts & agreements' },
          { id: 'notice',      title: 'Legal Notice',        description: 'Send or reply to notice' },
          { id: 'review',      title: 'Contract Review',     description: 'Review existing contract' },
        ],
      },
      {
        key: 'matter_status',
        label: 'Status',
        prompt: 'Is this a new requirement or an existing / ongoing case?',
        input: 'buttons',
        required: true,
        options: [
          { id: 'new',      title: 'New' },
          { id: 'existing', title: 'Existing' },
        ],
      },
      {
        key: 'business_name',
        label: 'Business Name',
        prompt: "What's your business name?",
        input: 'text',
        required: true,
        validate: 'free',
      },
      {
        key: 'city',
        label: 'City',
        prompt: 'Which city are you in?',
        input: 'text',
        required: true,
        validate: 'city',
      },
      STEP_NAME,
      STEP_MOBILE,
    ],
  },

  // ═══════════════════════════════════════════════════════════
  //  7. International Expansion
  // ═══════════════════════════════════════════════════════════
  intl: {
    id: 'intl',
    label: 'International Expansion',
    menu: { title: 'Intl Expansion', description: 'Overseas setup, IEC, Tax advisory' },
    steps: [
      {
        key: 'country',
        label: 'Country',
        prompt: 'Which country are you expanding to?',
        input: 'list',
        listButton: 'Choose Country',
        required: true,
        options: [
          { id: 'uae',       title: 'UAE',          description: 'Dubai, Abu Dhabi & more' },
          { id: 'saudi',     title: 'Saudi Arabia', description: 'KSA' },
          { id: 'qatar',     title: 'Qatar',        description: 'Doha' },
          { id: 'oman',      title: 'Oman',         description: 'Muscat' },
          { id: 'usa',       title: 'USA',          description: 'United States' },
          { id: 'uk',        title: 'UK',           description: 'United Kingdom' },
          { id: 'singapore', title: 'Singapore',    description: 'Singapore' },
          { id: 'other',     title: 'Other',        description: 'Another country' },
        ],
      },
      {
        key: 'intl_need',
        label: 'Requirement',
        prompt: 'What do you need help with?',
        input: 'list',
        listButton: 'Choose Service',
        required: true,
        options: [
          { id: 'setup',     title: 'Company Setup',  description: 'Incorporate overseas' },
          { id: 'visa',      title: 'Business Visa',  description: 'Visa & residency' },
          { id: 'bank',      title: 'Bank Account',   description: 'Overseas banking' },
          { id: 'vat',       title: 'VAT',            description: 'VAT registration & filing' },
          { id: 'importexp', title: 'Import Export',  description: 'Trade compliance' },
          { id: 'tax',       title: 'Tax Advice',     description: 'Cross-border taxation' },
        ],
      },
      {
        key: 'business_name',
        label: 'Business Name',
        prompt: "What's your business name?",
        input: 'text',
        required: false,
        validate: 'free',
      },
      STEP_NAME,
      STEP_MOBILE,
    ],
  },

  // ═══════════════════════════════════════════════════════════
  //  8. Office Setup
  // ═══════════════════════════════════════════════════════════
  office: {
    id: 'office',
    label: 'Office Setup',
    menu: { title: 'Office Setup', description: 'Virtual office, Furniture, Setup' },
    steps: [
      {
        key: 'office_need',
        label: 'Requirement',
        prompt: 'What do you need?',
        input: 'list',
        listButton: 'Choose Service',
        required: true,
        options: [
          { id: 'virtual',    title: 'Virtual Office',      description: 'Registered address' },
          { id: 'furniture',  title: 'Furniture',           description: 'New or refurbished' },
          { id: 'interior',   title: 'Interior',            description: 'Design & fit-out' },
          { id: 'networking', title: 'Networking',          description: 'LAN, WiFi, cabling' },
          { id: 'cctv',       title: 'CCTV',                description: 'Surveillance setup' },
          { id: 'biometric',  title: 'Biometric',           description: 'Attendance & access' },
          { id: 'complete',   title: 'Complete Office Setup', description: 'End-to-end turnkey' },
        ],
      },
      {
        key: 'city',
        label: 'City',
        prompt: 'Which city are you in?',
        input: 'text',
        required: true,
        validate: 'city',
      },
      {
        key: 'office_size',
        label: 'Office Size',
        prompt: "What's the office size?",
        input: 'buttons',
        required: true,
        options: [
          { id: 'small',  title: 'Small' },
          { id: 'medium', title: 'Medium' },
          { id: 'large',  title: 'Large' },
        ],
      },
      STEP_NAME,
      STEP_MOBILE,
    ],
  },

  // ═══════════════════════════════════════════════════════════
  //  9. Software & Tools Marketplace — split step
  //  Doc: each branch counts its own 6-step cap independently,
  //  so the split is its own one-step flow that branches out.
  // ═══════════════════════════════════════════════════════════
  marketplace: {
    id: 'marketplace',
    label: 'Software & Tools Marketplace',
    menu: { title: 'Software Marketplace', description: 'Find tools or list your software' },
    steps: [
      {
        key: 'listing_type',
        label: 'Listing Type',
        prompt: 'Are you looking for the right tool, or would you like to list your software?',
        input: 'buttons',
        required: true,
        options: [
          { id: 'buyer',  title: 'Find the Right Tool' },
          { id: 'seller', title: 'List My Software' },
        ],
        // Hands control to a fresh flow — step counter resets to 1,
        // which is what the doc's "counts separately" note requires.
        branchTo: (value) => (value === 'seller' ? 'mp_seller' : 'mp_buyer'),
      },
    ],
  },

  // ── 9A. Buyer path ───────────────────────────────────────────
  mp_buyer: {
    id: 'mp_buyer',
    label: 'Marketplace — Find a Tool',
    hidden: true,                 // not shown in the main menu
    queue: 'marketplace_buyer',
    steps: [
      {
        key: 'tool_category',
        label: 'Tool Category',
        prompt: 'What kind of tool are you looking for?',
        input: 'list',
        listButton: 'Choose Category',
        required: true,
        options: [
          ...TOOL_CATEGORIES,
          // Doc title "Not Sure – Suggest Based on My Needs" is 36 chars.
          { id: 'not_sure', title: 'Not Sure - Suggest', description: 'Recommend based on my needs' },
        ],
      },
      {
        key: 'business_type',
        label: 'Business Type',
        prompt: "What's your business type?",
        input: 'list',
        listButton: 'Choose Type',
        required: true,
        options: [
          { id: 'startup',    title: 'Startup',    description: 'Early stage company' },
          { id: 'sme',        title: 'SME',        description: 'Small / medium business' },
          { id: 'freelancer', title: 'Freelancer', description: 'Independent professional' },
          { id: 'enterprise', title: 'Enterprise', description: 'Large organisation' },
        ],
      },
      {
        key: 'budget',
        label: 'Budget Range',
        prompt: "What's your budget range?",
        input: 'list',
        listButton: 'Choose Budget',
        required: true,
        options: [
          { id: 'under_5k',  title: 'Under \u20B95,000/mo',   description: 'Entry level' },
          { id: '5k_20k',    title: '\u20B95,000-\u20B920,000/mo', description: 'Mid range' },
          { id: 'above_20k', title: '\u20B920,000+/mo',       description: 'Premium tier' },
          { id: 'not_sure',  title: 'Not Sure',            description: 'Advise me' },
        ],
      },
      STEP_NAME,
      STEP_MOBILE,
    ],
  },

  // ── 9B. Seller path ──────────────────────────────────────────
  mp_seller: {
    id: 'mp_seller',
    label: 'Marketplace — List Software',
    hidden: true,
    queue: 'marketplace_listings',
    steps: [
      {
        key: 'product_category',
        label: 'Product Category',
        prompt: 'What type of product do you offer?',
        input: 'list',
        listButton: 'Choose Category',
        required: true,
        options: [
          ...TOOL_CATEGORIES,
          { id: 'other', title: 'Other', description: 'Something else' },
        ],
      },
      {
        key: 'product_name',
        label: 'Product / Company',
        prompt: "What's your company / product name?",
        input: 'text',
        required: true,
        validate: 'free',
      },
      {
        key: 'pricing_plan',
        label: 'Pricing Plan',
        prompt: "Do you have a pricing plan you'd like listed?",
        input: 'buttons',
        required: true,
        options: [
          { id: 'free_plan', title: 'Free Plan Available' },
          { id: 'paid_only', title: 'Paid Only' },
          { id: 'custom',    title: 'Custom / On Request' },
        ],
      },
      STEP_NAME,
      {
        key: 'work_email',
        label: 'Work Email',
        prompt: "What's your work email?",
        input: 'text',
        required: true,
        validate: 'email',
      },
      STEP_MOBILE,
    ],
  },
};

// ── Main menu rows (Doc §1) ───────────────────────────────────
// 8 categories + "Talk to an Expert" = 9 rows, within the 10 limit.
const MENU_ROWS = [
  ...Object.values(FLOWS)
    .filter((f) => !f.hidden)
    .map((f) => ({ id: f.id, title: f.menu.title, description: f.menu.description })),
  { id: 'expert', title: 'Talk to an Expert', description: 'Connect directly with our team' },
];

module.exports = { FLOWS, MENU_ROWS, TOOL_CATEGORIES };
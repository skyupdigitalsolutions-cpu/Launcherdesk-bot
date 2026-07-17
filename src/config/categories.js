// WhatsApp list limits: row title ≤24 chars, description ≤72 chars (emojis eat 2+)
// So NO emojis in row titles, keep them short.

const CATEGORIES = {
  biz_reg: {
    label: 'Business Registration',
    title: 'Business Registration',
    body: 'Private Limited, LLP, OPC, Section 8 (NGO), Trust/Society, Nidhi Company, Overseas Setup',
  },
  licenses: {
    label: 'Licenses & Certifications',
    title: 'Licenses & Certifications',
    body: 'GST, Startup India, MSME/Udyam, ISO, FSSAI, IEC, Trade License, Factory License',
  },
  finance: {
    label: 'Finance & Accounts',
    title: 'Finance & Accounts',
    body: 'Bookkeeping, GST Filing, Income Tax, Payroll, TDS Compliance, Auditing, Virtual CFO',
  },
  it_services: {
    label: 'IT Services',
    title: 'IT Services',
    body: 'Website Design, E-commerce, Digital Marketing, Business Email, ERP, Cloud Hosting',
  },
  legal: {
    label: 'Legal & Compliance',
    title: 'Legal & Compliance',
    body: 'Legal Drafting, Trademark, Copyright, Patent, ROC Compliance, Labour Law, Legal Notices',
  },
  intl: {
    label: 'International Expansion',
    title: 'International Expansion',
    body: 'Overseas Registration, IEC, Cross-Border Compliance, International Tax, Foreign Subsidiary',
  },
  office: {
    label: 'Office Setup Solutions',
    title: 'Office Setup Solutions',
    body: 'Virtual Office Address, Refurbished Office Furniture, Workspace Setup',
  },
};

// Rows shown in the interactive list menu (Step 2)
// title ≤24 chars, NO emojis. 'expert' is handled separately in the state machine.
const MENU_ROWS = [
  { id: 'biz_reg',     title: 'Business Registration', description: 'Pvt Ltd, LLP, OPC, NGO & more' },
  { id: 'licenses',    title: 'Licenses & Certs',      description: 'GST, MSME, FSSAI, ISO & more' },
  { id: 'finance',     title: 'Finance & Accounts',    description: 'Bookkeeping, GST filing, Payroll' },
  { id: 'it_services', title: 'IT Services',           description: 'Website, Ecommerce, ERP, Cloud' },
  { id: 'legal',       title: 'Legal & Compliance',    description: 'Trademark, ROC, Labour Law' },
  { id: 'intl',        title: 'Intl Expansion',        description: 'Overseas setup, IEC, Tax advisory' },
  { id: 'office',      title: 'Office Setup',          description: 'Virtual office, Furniture, Setup' },
  { id: 'expert',      title: 'Talk to an Expert',     description: 'Connect directly with our team' },
];

module.exports = { CATEGORIES, MENU_ROWS };
// ─────────────────────────────────────────────────────────────
//  LauncherDesk — Category Content Config
//  Edit service descriptions here without touching bot logic
// ─────────────────────────────────────────────────────────────

const CATEGORIES = {
  biz_reg: {
    label: '🏢 Business Registration',
    title: '🏢 Business Registration & Incorporation',
    body: [
      'Start your business with the right legal foundation. We handle:',
      '',
      '• Private Limited Company',
      '• LLP (Limited Liability Partnership)',
      '• OPC (One Person Company)',
      '• Section 8 Company (NGO)',
      '• Trust & Society Registration',
      '• Nidhi Company',
      '• Overseas Business Setup',
      '',
      '⏱️ Typical turnaround: 7–15 working days',
      '✅ End-to-end support — documentation to certificate',
      '',
      'Ready to get started?',
    ].join('\n'),
  },

  licenses: {
    label: '📄 Licenses & Certifications',
    title: '📄 Licenses & Certifications',
    body: [
      'Operating legally and credibly is non-negotiable. We help you obtain:',
      '',
      '• GST Registration',
      '• Startup India Recognition',
      '• MSME / Udyam Registration',
      '• ISO Certification',
      '• FSSAI (Food License)',
      '• IEC (Import Export Code)',
      '• Trade License',
      '• Factory License',
      '',
      '✅ We prepare, file, and follow up — you just sign.',
    ].join('\n'),
  },

  finance: {
    label: '💼 Finance & Accounts',
    title: '💼 Finance & Accounting Services',
    body: [
      'Keep your books clean and your compliance tight:',
      '',
      '• Bookkeeping & Accounting',
      '• GST Return Filing',
      '• Income Tax Filing (ITR)',
      '• Payroll Processing',
      '• TDS Compliance',
      '• Auditing Support',
      '• Virtual CFO Services',
      '',
      '✅ Trusted by 100+ businesses across India',
    ].join('\n'),
  },

  it_services: {
    label: '💻 IT Services',
    title: '💻 IT Services',
    body: [
      'Your digital presence, built professionally:',
      '',
      '• Website Design & Development',
      '• E-commerce Setup',
      '• Digital Marketing',
      '• Business Email & Domain Setup',
      '• ERP Solutions',
      '• Cloud Hosting & Management',
      '',
      '✅ One team. From domain to deployment.',
    ].join('\n'),
  },

  legal: {
    label: '⚖️ Legal & Compliance',
    title: '⚖️ Legal & Compliance',
    body: [
      'Stay protected and compliant at every stage:',
      '',
      '• Legal Drafting & Agreements',
      '• Trademark Registration',
      '• Copyright & Patent Filing',
      '• ROC / Annual Compliance',
      '• Labour Law Compliance',
      '• Legal Notices & Representation',
      '',
      '✅ Expert legal support without the premium law firm cost.',
    ].join('\n'),
  },

  intl: {
    label: '🌍 International Expansion',
    title: '🌍 International Expansion',
    body: [
      'Take your business global with confidence:',
      '',
      '• Overseas Business Registration',
      '• Import Export Code (IEC)',
      '• Cross-Border Compliance',
      '• International Tax Advisory',
      '• Foreign Subsidiary Setup',
      '',
      '✅ We handle the complexity so you can focus on growth.',
    ].join('\n'),
  },

  office: {
    label: '🏢 Office Setup Solutions',
    title: '🏢 Office Setup Solutions',
    body: [
      'Everything you need to set up a professional workspace:',
      '',
      '• 📍 Virtual Office Address — premium business addresses across India',
      '• 🪑 Refurbished Office Furniture — quality furniture at startup-friendly prices',
      '• 🛠️ Full Workspace Setup — end-to-end office design & fit-out',
      '',
      '✅ Whether you need an address or a full office — we\'ve got it covered.',
    ].join('\n'),
  },
};

// List rows for the main menu (order matters — shows in this sequence)
const MENU_ROWS = [
  { id: 'biz_reg',     title: '🏢 Business Registration',    description: 'Pvt Ltd, LLP, OPC, NGO & more' },
  { id: 'licenses',    title: '📄 Licenses & Certifications', description: 'GST, MSME, FSSAI, ISO & more' },
  { id: 'finance',     title: '💼 Finance & Accounts',        description: 'Bookkeeping, GST filing, Payroll' },
  { id: 'it_services', title: '💻 IT Services',               description: 'Website, Ecommerce, ERP, Cloud' },
  { id: 'legal',       title: '⚖️ Legal & Compliance',        description: 'Trademark, ROC, Labour Law' },
  { id: 'intl',        title: '🌍 International Expansion',   description: 'Overseas setup, IEC, Tax advisory' },
  { id: 'office',      title: '🏢 Office Setup Solutions',    description: 'Virtual office, Furniture, Workspace' },
  { id: 'expert',      title: '💬 Talk to an Expert',         description: 'Connect directly with our team' },
];

module.exports = { CATEGORIES, MENU_ROWS };

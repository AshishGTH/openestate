// @ts-check

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'OpenEstate',
  tagline: 'Self-hosted, open-source CRM for real estate — and beyond.',
  // No favicon shipped yet — no real brand asset exists in this repo to
  // reference (docs/static/ was an empty, git-untracked directory until
  // Phase 8 gave the docs site its first real build verification; found
  // while confirming the new security docs pages actually compile).
  // Omitting `favicon` is valid Docusaurus config; add a real one before
  // going public rather than fabricating a placeholder icon.
  url: 'https://openestate.example.com',
  baseUrl: '/',
  organizationName: 'AshishGTH',
  projectName: 'openestate',
  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },
  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: require.resolve('./sidebars.js'),
          routeBasePath: '/',
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],
  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      navbar: {
        title: 'OpenEstate',
        items: [
          { type: 'doc', docId: 'intro', position: 'left', label: 'Docs' },
          {
            href: 'https://github.com/AshishGTH/openestate',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
    }),
};

module.exports = config;

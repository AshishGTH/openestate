// @ts-check

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'OpenEstate',
  tagline: 'Self-hosted, open-source CRM for real estate — and beyond.',
  favicon: 'img/favicon.ico',
  url: 'https://openestate.example.com',
  baseUrl: '/',
  organizationName: 'openestate',
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
            href: 'https://github.com/openestate/openestate',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
    }),
};

module.exports = config;

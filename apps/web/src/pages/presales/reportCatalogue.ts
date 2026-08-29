/**
 * Single source of truth for the pre-sales Reports page — one FilterBar +
 * DataTable pattern reused across every report, driven by this config,
 * instead of a bespoke page per report (CLAUDE.md's reporting-suite
 * decisions). `key` doubles as the backend's `reportKey` used in the
 * audit-log entity id, so it must match the controller route's audit call.
 */

export interface ReportColumn {
  /** For `rowShape: 'object'` — the property name on each row object.
   *  For `rowShape: 'array'` — the positional index into the row array,
   *  as a string (DataTable needs a stable string key either way). */
  key: string;
  header: string;
}

export type ReportCategory = 'Lead Reports' | 'Activity & Compliance' | 'Supervisor Review' | 'Conversion';

export interface ReportDef {
  key: string;
  label: string;
  category: ReportCategory;
  endpoint: string;
  /** 'object': buffered aggregate, JSON is an array of objects.
   *  'array': row-level/streamed, JSON is an array of value-arrays in `columns` order. */
  rowShape: 'object' | 'array';
  columns: ReportColumn[];
  filters: {
    dateRange: boolean;
    project?: boolean;
    executive?: boolean;
  };
  /** Hand-rolled SVG chart toggle for label/count-shaped aggregates — no charting library. */
  chart?: { type: 'bar' | 'donut'; labelKey: string; valueKey: string };
}

export const REPORT_CATALOGUE: ReportDef[] = [
  {
    key: 'daily-inquiries',
    label: 'Daily Inquiries (staff-wise)',
    category: 'Lead Reports',
    endpoint: '/reports/presales/daily-inquiries',
    rowShape: 'object',
    columns: [
      { key: 'staffName', header: 'Staff' },
      { key: 'count', header: 'Count' },
    ],
    filters: { dateRange: true, project: true },
    chart: { type: 'bar', labelKey: 'staffName', valueKey: 'count' },
  },
  {
    key: 'funnel',
    label: 'Funnel by Status',
    category: 'Lead Reports',
    endpoint: '/reports/presales/funnel',
    rowShape: 'object',
    columns: [
      { key: 'status', header: 'Status' },
      { key: 'count', header: 'Count' },
    ],
    filters: { dateRange: true, project: true },
    chart: { type: 'donut', labelKey: 'status', valueKey: 'count' },
  },
  {
    key: 'budget-band',
    label: 'Budget-Band Analysis',
    category: 'Lead Reports',
    endpoint: '/reports/presales/budget-band',
    rowShape: 'object',
    columns: [
      { key: 'band', header: 'Band' },
      { key: 'count', header: 'Count' },
    ],
    filters: { dateRange: true, project: true },
    chart: { type: 'bar', labelKey: 'band', valueKey: 'count' },
  },
  {
    key: 'ageing',
    label: 'Ageing Buckets',
    category: 'Lead Reports',
    endpoint: '/reports/presales/ageing',
    rowShape: 'object',
    columns: [
      { key: 'bucket', header: 'Bucket' },
      { key: 'count', header: 'Count' },
    ],
    filters: { dateRange: true, project: true },
    chart: { type: 'bar', labelKey: 'bucket', valueKey: 'count' },
  },
  {
    key: 'leads-by-stage',
    label: 'Leads by Stage',
    category: 'Lead Reports',
    endpoint: '/reports/presales/leads-by-stage',
    rowShape: 'object',
    columns: [
      { key: 'stageName', header: 'Stage' },
      { key: 'count', header: 'Count' },
    ],
    filters: { dateRange: true, project: true },
    chart: { type: 'bar', labelKey: 'stageName', valueKey: 'count' },
  },
  {
    key: 'enquiry-type',
    label: 'Enquiry-Type Breakdown',
    category: 'Lead Reports',
    endpoint: '/reports/presales/enquiry-type',
    rowShape: 'object',
    columns: [
      { key: 'name', header: 'Enquiry Type' },
      { key: 'count', header: 'Count' },
    ],
    filters: { dateRange: true, project: true },
    chart: { type: 'donut', labelKey: 'name', valueKey: 'count' },
  },
  {
    key: 'inquiries-export',
    label: 'Inquiries Export',
    category: 'Lead Reports',
    endpoint: '/reports/presales/inquiries-export',
    rowShape: 'array',
    // Fixed columns only — this report also carries one column per active
    // custom field, decided per company at export time. The on-screen
    // table shows the fixed portion; a CSV export always includes every
    // custom-field column too, via the backend's own dynamic header row.
    columns: [
      { key: '0', header: 'Inquiry ID' },
      { key: '1', header: 'Created At' },
      { key: '2', header: 'Status' },
      { key: '3', header: 'Applicant' },
      { key: '4', header: 'Phone' },
      { key: '5', header: 'Email' },
      { key: '6', header: 'Project' },
      { key: '7', header: 'Source' },
      { key: '8', header: 'Temperature' },
      { key: '9', header: 'Assigned To' },
    ],
    filters: { dateRange: true, project: true },
  },
  {
    key: 'source-wise',
    label: 'Source-Wise Conversion',
    category: 'Conversion',
    endpoint: '/reports/presales/source-wise',
    rowShape: 'object',
    columns: [
      { key: 'sourceName', header: 'Source' },
      { key: 'total', header: 'Total' },
      { key: 'successful', header: 'Successful' },
      { key: 'conversionPercent', header: 'Conversion %' },
      { key: 'bookingLinked', header: 'Booking-Linked' },
      { key: 'bookingLinkedConversionPercent', header: 'Booking-Linked %' },
    ],
    filters: { dateRange: true, project: true },
    chart: { type: 'bar', labelKey: 'sourceName', valueKey: 'conversionPercent' },
  },
  {
    key: 'staff-performance',
    label: 'Staff Performance',
    category: 'Activity & Compliance',
    endpoint: '/reports/presales/staff-performance',
    rowShape: 'object',
    columns: [
      { key: 'staffName', header: 'Staff' },
      { key: 'totalAssigned', header: 'Assigned' },
      { key: 'successful', header: 'Successful' },
      { key: 'dumped', header: 'Dumped' },
      { key: 'conversionPercent', header: 'Conversion %' },
      { key: 'bookingLinked', header: 'Booking-Linked' },
      { key: 'bookingLinkedConversionPercent', header: 'Booking-Linked %' },
    ],
    filters: { dateRange: true, project: true },
  },
  {
    key: 'manager-wise',
    label: 'Manager-Wise Interactions',
    category: 'Activity & Compliance',
    endpoint: '/reports/presales/manager-wise',
    rowShape: 'object',
    columns: [
      { key: 'managerName', header: 'Manager' },
      { key: 'interactionCount', header: 'Interactions' },
    ],
    filters: { dateRange: true },
    chart: { type: 'bar', labelKey: 'managerName', valueKey: 'interactionCount' },
  },
  {
    key: 'daily-work',
    label: 'Daily Work Report',
    category: 'Activity & Compliance',
    endpoint: '/reports/presales/daily-work',
    rowShape: 'object',
    columns: [
      { key: 'userName', header: 'User' },
      { key: 'followUpsLogged', header: 'Follow-Ups Logged' },
      { key: 'leadsTouched', header: 'Leads Touched' },
      { key: 'stageChanges', header: 'Stage Changes' },
      { key: 'dispositionsSet', header: 'Dispositions Set' },
    ],
    filters: { dateRange: true },
  },
  {
    key: 'dump-report',
    label: 'Dump Report',
    category: 'Activity & Compliance',
    endpoint: '/reports/presales/dump-report',
    rowShape: 'array',
    columns: [
      { key: '0', header: 'Date' },
      { key: '1', header: 'Applicant' },
      { key: '2', header: 'Executive' },
      { key: '3', header: 'Reason' },
      { key: '4', header: 'Remarks' },
    ],
    filters: { dateRange: true, executive: true },
  },
  {
    key: 'site-visit',
    label: 'Site Visit Report',
    category: 'Activity & Compliance',
    endpoint: '/reports/presales/site-visit',
    rowShape: 'array',
    columns: [
      { key: '0', header: 'Date' },
      { key: '1', header: 'Executive' },
      { key: '2', header: 'Applicant' },
      { key: '3', header: 'Project' },
      { key: '4', header: 'Venue' },
      { key: '5', header: 'Outcome' },
    ],
    filters: { dateRange: true, executive: true },
  },
  {
    key: 'stage-transitions',
    label: 'Stage Transitions',
    category: 'Activity & Compliance',
    endpoint: '/reports/presales/stage-transitions',
    rowShape: 'object',
    columns: [
      { key: 'fromStageName', header: 'From Stage' },
      { key: 'toStageName', header: 'To Stage' },
      { key: 'count', header: 'Count' },
    ],
    filters: { dateRange: true },
  },
  {
    key: 'stage-velocity',
    label: 'Stage Velocity',
    category: 'Activity & Compliance',
    endpoint: '/reports/presales/stage-velocity',
    rowShape: 'object',
    columns: [
      { key: 'stageName', header: 'Stage' },
      { key: 'avgDays', header: 'Avg. Days' },
      { key: 'sampleSize', header: 'Sample Size' },
    ],
    filters: { dateRange: true },
    chart: { type: 'bar', labelKey: 'stageName', valueKey: 'avgDays' },
  },
  {
    key: 'follow-up-overdue',
    label: 'Follow-Up Overdue (live)',
    category: 'Activity & Compliance',
    endpoint: '/reports/presales/follow-up-overdue',
    rowShape: 'object',
    columns: [
      { key: 'executiveName', header: 'Executive' },
      { key: 'overdueCount', header: 'Overdue Count' },
    ],
    filters: { dateRange: false },
    chart: { type: 'bar', labelKey: 'executiveName', valueKey: 'overdueCount' },
  },
  {
    key: 'follow-up-delay',
    label: 'Follow-Up Delay',
    category: 'Activity & Compliance',
    endpoint: '/reports/presales/follow-up-delay',
    rowShape: 'object',
    columns: [
      { key: 'executiveName', header: 'Executive' },
      { key: 'avgDelayHours', header: 'Avg. Delay (hrs)' },
      { key: 'closedCount', header: 'Closed Count' },
    ],
    filters: { dateRange: true },
  },
  {
    key: 'communication-type',
    label: 'Communication-Type Breakdown',
    category: 'Activity & Compliance',
    endpoint: '/reports/presales/communication-type',
    rowShape: 'object',
    columns: [
      { key: 'typeName', header: 'Type' },
      { key: 'totalFollowUps', header: 'Follow-Ups' },
      { key: 'distinctInquiries', header: 'Distinct Leads' },
      { key: 'bookingLinked', header: 'Booking-Linked' },
      { key: 'bookingLinkedConversionPercent', header: 'Booking-Linked %' },
    ],
    filters: { dateRange: true },
    chart: { type: 'donut', labelKey: 'typeName', valueKey: 'totalFollowUps' },
  },
  {
    key: 'supervisor-review-queue',
    label: 'Supervisor Review Queue',
    category: 'Supervisor Review',
    endpoint: '/reports/presales/supervisor-review-queue',
    rowShape: 'array',
    columns: [
      { key: '0', header: 'Date' },
      { key: '1', header: 'Type' },
      { key: '2', header: 'Applicant' },
      { key: '3', header: 'From / Changed By' },
      { key: '4', header: 'To' },
      { key: '5', header: 'Reason' },
    ],
    filters: { dateRange: true, executive: true },
  },
];

export const REPORT_CATEGORIES: ReportCategory[] = [
  'Lead Reports',
  'Activity & Compliance',
  'Supervisor Review',
  'Conversion',
];

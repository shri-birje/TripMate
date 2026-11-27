/**
 * The words on the public website. Features are limited to what the app does today; repayment recording is shown only
 * as "coming next". Nothing here is legal wording, a contact detail or a company fact: the footer pages are marked
 * placeholders until real content is supplied.
 */
export const FEATURES = [
  { title: 'Plan and manage trips', body: 'Dates, a destination and a status that follows the calendar, in one shared place for the whole group.', icon: 'route' },
  { title: 'Invite with roles', body: 'Share a link, approve who joins, and give admins and members the access they need.', icon: 'users' },
  { title: 'Split any way', body: 'Equally, by exact amounts, by percentages or by shares, checked so every rupee is accounted for.', icon: 'split' },
  { title: 'Clear group balances', body: 'See who is owed and who owes, always adding up to zero.', icon: 'scale' },
  { title: 'Suggested payments', body: 'The fewest payments to settle up, with your own payments shown apart from everyone else’s.', icon: 'link' },
  { title: 'An honest history', body: 'Every expense change is kept. Archive finished trips and bring them back any time.', icon: 'clock' },
] as const;

export const STEPS = [
  { title: 'Create a trip', body: 'Name it, pick the dates and a currency.' },
  { title: 'Add people and costs', body: 'Invite friends, then log shared expenses as they happen.' },
  { title: 'Settle up', body: 'See the balances and follow the suggested payments.' },
] as const;

export type InfoPage = 'about' | 'contact' | 'privacy' | 'terms' | 'help';

export const INFO_PAGES: Record<InfoPage, { title: string; intro: string | null }> = {
  about: { title: 'About TripMate', intro: 'TripMate helps groups plan trips together and keep shared costs clear: who paid, who owes whom, and the fewest payments to settle up.' },
  contact: { title: 'Contact', intro: null },
  privacy: { title: 'Privacy Policy', intro: null },
  terms: { title: 'Terms and Conditions', intro: null },
  help: { title: 'Help', intro: null },
};

export const isInfoPage = (v: string): v is InfoPage => Object.prototype.hasOwnProperty.call(INFO_PAGES, v);

export const PLACEHOLDER_NOTICE =
  'This page is a placeholder. The final wording has not been written or approved yet, so nothing here should be read as a policy, a commitment or contact information.';

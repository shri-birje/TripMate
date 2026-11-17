/**
 * Turns Supabase Auth errors into short, friendly sentences.
 *
 * We never show the server's raw message: it can be technical, and for some
 * errors it could reveal more than a user (or an attacker) should learn.
 * Sign-in failures deliberately do not say whether the email exists.
 */
export interface AuthErrorLike {
  code?: string | undefined;
  message?: string | undefined;
  name?: string | undefined;
  status?: number | undefined;
}

const BY_CODE: Record<string, string> = {
  invalid_credentials: "That email and password don't match. Check them and try again.",
  email_not_confirmed: 'Please confirm your email first. Check your inbox for the confirmation link.',
  user_already_exists: 'An account with this email already exists. Try signing in instead.',
  email_exists: 'An account with this email already exists. Try signing in instead.',
  weak_password: 'That password is too easy to guess. Try a longer one with letters and numbers.',
  over_email_send_rate_limit: 'Too many emails were requested. Please wait a few minutes and try again.',
  over_request_rate_limit: 'Too many attempts. Please wait a minute and try again.',
  email_address_invalid: "That email address isn't accepted. Check it for typos.",
  email_address_not_authorized: "That email address can't be used right now.",
  signup_disabled: 'New sign-ups are turned off right now.',
  user_banned: 'This account has been disabled.',
  validation_failed: 'Please check the details you entered.',
  invalid_api_key: "The app isn't connected to its server correctly. Please try again later.",
  no_authorization: "The app isn't connected to its server correctly. Please try again later.",
};

const NETWORK = "Can't reach the server. Check your internet connection and try again.";
const FALLBACK = 'Something went wrong. Please try again.';

function looksLikeNetworkFailure(e: AuthErrorLike): boolean {
  if (e.name === 'AuthRetryableFetchError' || e.name === 'TypeError') return true;
  if (e.status === 0) return true;
  return /failed to fetch|network request failed|networkerror|load failed/i.test(e.message ?? '');
}

export function friendlyAuthError(error: AuthErrorLike | null | undefined): string {
  if (!error) return FALLBACK;
  if (error.code && BY_CODE[error.code]) return BY_CODE[error.code]!;
  if (looksLikeNetworkFailure(error)) return NETWORK;
  if (error.status === 429) return BY_CODE.over_request_rate_limit!;
  return FALLBACK;
}

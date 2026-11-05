/**
 * The two refusals of the forgotten-PIN step (DOC-507 5.2 item 5, 5.3), kept in
 * a module with no imports so the restorer can throw them without pulling the UI
 * copy's dependencies.
 */
export const NOTHING_TO_ADD_TEXT =
  "There's nothing in this backup that can be added to this phone. Your PIN is still here, and nothing has changed.";
export const NO_KEYS_TEXT =
  "This backup doesn't hold any account keys, so restoring it without your PIN wouldn't give you back any account you can sign with. Your PIN is still on this phone, and nothing has changed. Enter your PIN, or use a backup that has your keys.";

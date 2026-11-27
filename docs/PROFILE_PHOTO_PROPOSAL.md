# Profile photo: architecture proposal (NOT implemented, awaiting approval)

Status: proposal only. Nothing in this document has been built, applied to Supabase, or added as a dependency. It needs a new
migration, Storage policies and (probably) new dependencies, so per the brief it stops here for approval.

## What already exists

| Piece | State |
|---|---|
| `profiles.avatar_path text` (migration #1) | **Exists.** Documented as "Storage path, not a public URL". Users may update it (column grant `update (display_name, avatar_path, ...)`). Nothing reads or writes it yet. |
| Core `Profile.avatarPath` | Exists (read-only mapping in `packages/core/src/profile.ts`). |
| Supabase Storage bucket and policies | **None.** No migration creates a bucket or any `storage.objects` policy. |
| Image dependencies (`expo-image-picker`, `expo-image-manipulator`, `expo-file-system`) | **None** in `apps/app/package.json`. |
| UI | A default `Avatar` component (initial, or a user icon) is shown in Profile and the desktop sidebar. No upload control is shown, because upload does not exist. |
| Security docs | `SECURITY_ARCHITECTURE.md` already requires private buckets and short-lived signed URLs, and says other people may see only the `display_name` and avatar of people who share an active trip. |

## Proposal

1. **Where stored.** One private Supabase Storage bucket, `avatars`. Object path `{user_id}/{uuid}.jpg` (a new unique name per upload, so a
   replaced photo is never served stale from a cache). `profiles.avatar_path` holds that path (never a URL, never image bytes).
2. **Bucket required?** Yes: `avatars`, `public = false`, `file_size_limit = 512 KB`, `allowed_mime_types = image/jpeg`.
3. **Column / migration.** No new column (reuse `avatar_path`). One new migration (#13) would: create the bucket, add the Storage policies below,
   and add a CHECK so `avatar_path` is either null or starts with the owner's own id (`avatar_path like id::text || '/%'`), so a user cannot point
   their profile at someone else's file.
4. **Policies and ownership.** On `storage.objects` for bucket `avatars`:
   - INSERT / UPDATE / DELETE only where the first path segment equals `auth.uid()::text`.
   - SELECT only for the owner, or for someone who shares an **active trip** with the owner (a SECURITY DEFINER helper, same pattern as the existing member checks).
   - No `anon` access of any kind. No service-role key in the app.
5. **Who can see a photo.** The owner, and people who currently share an active trip with them. Nobody else, and nobody by guessing a URL.
6. **Validation.** Client: JPEG, PNG or WebP only; input up to 5 MB; refuse anything else with a plain message. Server: bucket MIME and size limits above
   (the real enforcement), plus the path CHECK.
7. **Resize and compress.** Re-encode on the device to a 256 x 256 centre crop, JPEG quality about 0.8 (typically 15 to 40 KB). Re-encoding also strips location and
   other EXIF data. Web can do this with the browser canvas (no dependency); native needs an image-manipulation dependency (below).
8. **Replace and remove.** Replace: upload the new object, then set `avatar_path`, then delete the old object (best effort; a failed delete leaves a small orphan,
   which a periodic cleanup could remove). Remove: set `avatar_path = null`, then delete the object.
9. **Selecting a photo.** Native: the photo library through the image picker. Web: a standard file input (`<input type="file" accept="image/*">`).
10. **Dependencies (need approval).** `expo-image-picker` (library selection on native, file selection on web) and `expo-image-manipulator` (resize and re-encode on native).
    Both are first-party Expo packages. An alternative with no new packages is web-only support first.
11. **Free-tier cost.** Supabase's free plan includes a small Storage quota and monthly download allowance (the figures change; check the current plan page before launch).
    At about 30 KB per photo, 1,000 users is about 30 MB of storage. Bandwidth is the larger risk because members' avatars are fetched repeatedly; signed URLs
    are cached by the app for most of their life (and by the browser), and the tiny size keeps this low.
12. **Loading, error and fallback.** The initials/icon `Avatar` shows immediately and while loading; if the signed URL or download fails, or the file is gone,
    it simply keeps showing the initials. Upload errors are shown in plain words with Try again; a failed upload never changes the profile.

## Reading photos

Display uses short-lived signed URLs (`createSignedUrl`, about one hour) fetched with the person's own login and cached in React Query keyed by user id and
path, so one account never sees another's cache. People's photos are only requested for members you share an active trip with, which the SELECT policy enforces.

## Decision needed

Approve (or change): the bucket and policies (item 4), migration #13 (item 3), and the two dependencies (item 10), or choose web-only first.
Until then the app shows initials only and offers no upload button.

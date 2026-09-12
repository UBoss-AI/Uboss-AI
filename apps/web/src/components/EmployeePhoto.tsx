'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Banner, Button } from '@uboss/ui';

import { ApiError, photoContentUrl, photosApi, type PhotoView } from '../lib/api-client';

export interface EmployeePhotoProps {
  tenantId: string;
  userId: string;
  /** Used for the initials fallback before the server answers, and for the alt text. */
  displayName: string;
  size?: 'sm' | 'md' | 'lg';
  /** Show upload / replace / remove. Off for a read-only place like a person selector. */
  editable?: boolean;
  /**
   * An already-loaded photo, for a list.
   *
   * A table of forty people rendering forty of these would make forty requests, which is why
   * `photosApi.viewMany` exists. Pass the row from that one call and this component skips its
   * own fetch entirely; leave it undefined and it loads its own, which is right for a profile.
   *
   * Explicit `null` means "loaded, and there is no photo" — distinct from undefined, which means
   * "not given, fetch it yourself".
   */
  prefetched?: PhotoView | null;
  onChanged?: () => void;
}

/** First and last initial — the same rule the server uses, so the two never disagree. */
function initialsOf(displayName: string): string {
  const words = displayName
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] as string).charAt(0).toUpperCase();
  return `${(words[0] as string).charAt(0)}${(words[words.length - 1] as string).charAt(0)}`.toUpperCase();
}

/**
 * An employee's optional photo — Prompt 40A (CR-03) §3.
 *
 * ## Initials are the normal state, not the error state
 *
 * Most people will not have a photo, so the fallback has to look deliberate rather than broken.
 * The server returns `initials` on every response precisely so no screen has to compute a fallback
 * from a name it may not have loaded — and this component still knows the rule, so it can render
 * something sensible before the first response arrives.
 *
 * ## A photo awaiting a scan looks exactly like no photo
 *
 * `viewable: false` means the malware scan has not cleared the file. The component shows initials —
 * **the same thing it shows for no photo at all** — rather than a "pending" state. A distinct
 * pending badge would tell whoever uploaded the file what the scanner is doing, which is not
 * information an uploader is entitled to.
 *
 * ## Nothing here touches Add Employee
 *
 * The six mandatory fields are unchanged. A photo is set after a person exists, from their profile
 * or from the Hierarchy, and this component is what does it.
 */
export function EmployeePhoto({
  tenantId,
  userId,
  displayName,
  size = 'md',
  editable = false,
  prefetched,
  onChanged,
}: EmployeePhotoProps) {
  const [photo, setPhoto] = useState<PhotoView | null>(prefetched ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      setPhoto(await photosApi.view(tenantId, userId));
    } catch {
      // A photo that cannot be loaded is not an error worth a banner: initials are a correct
      // rendering of "we have no picture", whatever the reason.
      setPhoto(null);
    }
  }, [tenantId, userId]);

  useEffect(() => {
    // A caller that supplied the photo has already made this request for the whole list.
    // Still refetched after an upload or a removal, because then this component knows the
    // list's copy is stale and the caller does not.
    if (prefetched !== undefined) {
      setPhoto(prefetched);
      return;
    }
    void load();
  }, [load, prefetched]);

  const choose = () => fileInput.current?.click();

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      await photosApi.upload(tenantId, userId, {
        filename: file.name,
        contentType: file.type,
        contentBase64: base64,
      });
      await load();
      onChanged?.();
    } catch (caught) {
      // The server's own words: it knows the size limit and the accepted formats, and it is the
      // thing that will refuse a colleague's photo to somebody without `users:EditDraft`.
      setError(caught instanceof ApiError ? caught.message : 'That photo could not be saved.');
    } finally {
      setBusy(false);
      if (fileInput.current !== null) fileInput.current.value = '';
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await photosApi.remove(tenantId, userId);
      await load();
      onChanged?.();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That photo could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  const initials = photo?.initials ?? initialsOf(displayName);
  const showPicture = photo !== null && photo.viewable && photo.storedFileId !== null;

  return (
    <div className={`employee-photo employee-photo-${size}`} data-testid="employee-photo">
      {showPicture ? (
        <img
          className="employee-photo-image"
          // The photo's own content route, not the generic file download: that one needs
          // `settings:Export`, which a standard Employee does not hold, so every avatar would be
          // a broken image for most of the company.
          src={photoContentUrl(tenantId, userId)}
          alt={`${displayName}'s photo`}
          data-testid="employee-photo-image"
        />
      ) : (
        // Not an error state. A person with no photo, and a person whose photo is still being
        // checked, get the same circle — which is the point.
        <span
          className="employee-photo-initials"
          aria-label={`${displayName} has no photo`}
          data-testid="employee-photo-initials"
        >
          {initials}
        </span>
      )}

      {editable ? (
        <div className="employee-photo-actions">
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="employee-photo-file"
            aria-label="Choose a photo"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void upload(file);
            }}
          />
          <Button variant="default" size="sm" onClick={choose} disabled={busy}>
            {showPicture ? 'Replace' : 'Upload'}
          </Button>
          {photo?.storedFileId !== null && photo !== null ? (
            <Button variant="ghost" size="sm" onClick={() => void remove()} disabled={busy}>
              Remove
            </Button>
          ) : null}
          <p className="employee-photo-note">
            Optional. Not one of the six required fields, and nothing to do with identity checks.
          </p>
        </div>
      ) : null}

      {error !== null ? <Banner tone="danger">{error}</Banner> : null}
    </div>
  );
}

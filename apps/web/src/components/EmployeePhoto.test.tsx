import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PhotoView } from '../lib/api-client';

/**
 * The employee photo — Prompt 40A (CR-03) §3.
 *
 * The behaviour worth pinning is not that an image renders. It is that **three different situations
 * look identical on purpose**: no photo, a photo still being scanned, and a photo that failed to
 * load all show initials. A future change that adds a "pending" badge would tell whoever uploaded
 * the file what the malware scanner is doing, and these tests are what would catch it.
 */
const view = vi.fn();
const upload = vi.fn();
const remove = vi.fn();

vi.mock('../lib/api-client', () => ({
  ApiError: class ApiError extends Error {
    // The real one carries a status. Mirrored here so a test cannot construct a refusal the
    // client could never produce.
    constructor(
      message: string,
      readonly statusCode = 500,
    ) {
      super(message);
    }
  },
  photosApi: {
    view: (...args: unknown[]) => view(...args),
    upload: (...args: unknown[]) => upload(...args),
    remove: (...args: unknown[]) => remove(...args),
  },
  photoContentUrl: (tenantId: string, userId: string) =>
    `/api/tenants/${tenantId}/photos/${userId}/content`,
}));

const { EmployeePhoto } = await import('./EmployeePhoto');

const WITH_PHOTO: PhotoView = {
  userId: 'user-1',
  storedFileId: 'file-1',
  contentType: 'image/png',
  uploadedAt: '2026-09-01T09:00:00.000Z',
  viewable: true,
  initials: 'AP',
};

const NO_PHOTO: PhotoView = {
  userId: 'user-1',
  storedFileId: null,
  contentType: null,
  uploadedAt: null,
  viewable: false,
  initials: 'AP',
};

beforeEach(() => {
  vi.clearAllMocks();
  view.mockResolvedValue(NO_PHOTO);
  upload.mockResolvedValue(WITH_PHOTO);
  remove.mockResolvedValue({ removed: true });
});

describe('EmployeePhoto', () => {
  it('falls back to initials when there is no photo', async () => {
    render(<EmployeePhoto tenantId="tenant-1" userId="user-1" displayName="Anita Prasad" />);

    expect(await screen.findByTestId('employee-photo-initials')).toHaveTextContent('AP');
  });

  it('derives initials itself before the server has answered', () => {
    // The circle must be right on the first paint, not after a round trip — otherwise every
    // avatar in the Hierarchy flashes empty.
    view.mockReturnValue(new Promise(() => undefined));

    render(<EmployeePhoto tenantId="tenant-1" userId="user-1" displayName="Anita Prasad" />);

    expect(screen.getByTestId('employee-photo-initials')).toHaveTextContent('AP');
  });

  it('renders the photo once there is a viewable one', async () => {
    view.mockResolvedValue(WITH_PHOTO);

    render(<EmployeePhoto tenantId="tenant-1" userId="user-1" displayName="Anita Prasad" />);

    const image = await screen.findByTestId('employee-photo-image');
    // The photo's own content route, never the generic file download — that one needs
    // `settings:Export`, which a standard Employee does not hold.
    expect(image).toHaveAttribute('src', '/api/tenants/tenant-1/photos/user-1/content');
  });

  it('shows initials for a photo that has not cleared its scan, exactly as for no photo', async () => {
    view.mockResolvedValue({ ...WITH_PHOTO, viewable: false });

    render(<EmployeePhoto tenantId="tenant-1" userId="user-1" displayName="Anita Prasad" />);

    expect(await screen.findByTestId('employee-photo-initials')).toBeInTheDocument();
    expect(screen.queryByTestId('employee-photo-image')).not.toBeInTheDocument();
    // No "pending", no "scanning", no distinct state of any kind.
    expect(document.body.textContent ?? '').not.toMatch(/pending|scanning|checking/i);
  });

  it('offers nothing to change when it is not editable', async () => {
    view.mockResolvedValue(WITH_PHOTO);

    render(<EmployeePhoto tenantId="tenant-1" userId="user-1" displayName="Anita Prasad" />);
    await screen.findByTestId('employee-photo-image');

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers Upload when editable and there is no photo, and Replace when there is', async () => {
    const { unmount } = render(
      <EmployeePhoto tenantId="tenant-1" userId="user-1" displayName="Anita Prasad" editable />,
    );
    expect(await screen.findByRole('button', { name: 'Upload' })).toBeInTheDocument();
    unmount();

    view.mockResolvedValue(WITH_PHOTO);
    render(<EmployeePhoto tenantId="tenant-1" userId="user-1" displayName="Anita Prasad" editable />);
    expect(await screen.findByRole('button', { name: 'Replace' })).toBeInTheDocument();
  });

  it('offers Remove only when a photo exists', async () => {
    const { unmount } = render(
      <EmployeePhoto tenantId="tenant-1" userId="user-1" displayName="Anita Prasad" editable />,
    );
    await screen.findByRole('button', { name: 'Upload' });
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    unmount();

    view.mockResolvedValue(WITH_PHOTO);
    render(<EmployeePhoto tenantId="tenant-1" userId="user-1" displayName="Anita Prasad" editable />);
    expect(await screen.findByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('uploads a chosen file and tells its caller something changed', async () => {
    const onChanged = vi.fn();
    render(
      <EmployeePhoto
        tenantId="tenant-1"
        userId="user-1"
        displayName="Anita Prasad"
        editable
        onChanged={onChanged}
      />,
    );
    await screen.findByRole('button', { name: 'Upload' });

    const file = new File(['binary'], 'face.png', { type: 'image/png' });
    await userEvent.upload(screen.getByLabelText('Choose a photo'), file);

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0]?.[2]).toMatchObject({
      filename: 'face.png',
      contentType: 'image/png',
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('removes a photo', async () => {
    view.mockResolvedValue(WITH_PHOTO);
    render(<EmployeePhoto tenantId="tenant-1" userId="user-1" displayName="Anita Prasad" editable />);

    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith('tenant-1', 'user-1'));
  });

  it("shows the server's own refusal rather than inventing one", async () => {
    const { ApiError } = await import('../lib/api-client');
    upload.mockRejectedValue(new ApiError('That file is larger than 2 MB.', 413));

    render(<EmployeePhoto tenantId="tenant-1" userId="user-1" displayName="Anita Prasad" editable />);
    await screen.findByRole('button', { name: 'Upload' });

    await userEvent.upload(
      screen.getByLabelText('Choose a photo'),
      new File(['binary'], 'face.png', { type: 'image/png' }),
    );

    expect(await screen.findByText('That file is larger than 2 MB.')).toBeInTheDocument();
  });

  it('does not fetch when the caller already loaded the photo', async () => {
    // The Hierarchy reads every photo in one request; forty of these must not make forty more.
    render(
      <EmployeePhoto
        tenantId="tenant-1"
        userId="user-1"
        displayName="Anita Prasad"
        prefetched={WITH_PHOTO}
      />,
    );

    expect(await screen.findByTestId('employee-photo-image')).toBeInTheDocument();
    expect(view).not.toHaveBeenCalled();
  });

  it('treats an explicitly null prefetch as "loaded, and there is none"', async () => {
    render(
      <EmployeePhoto
        tenantId="tenant-1"
        userId="user-1"
        displayName="Anita Prasad"
        prefetched={null}
      />,
    );

    expect(await screen.findByTestId('employee-photo-initials')).toHaveTextContent('AP');
    expect(view).not.toHaveBeenCalled();
  });
});

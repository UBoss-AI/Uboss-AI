'use client';

import React, { useEffect, useRef, useState } from 'react';

import { cn } from '../lib/class-names';
import { Icon } from './Icon';
import { sanitiseRichText } from './rich-text';

/**
 * A small formatting editor: bold, italic, underline, lists, colour, size and face.
 *
 * ## Why `contentEditable` and not an editor library
 *
 * Because of what is being written. This is a Vision and a Mission — a sentence and a paragraph,
 * set once and read every day. A document editor would bring a schema, a plugin system and a
 * couple of hundred kilobytes to a panel that needs seven buttons, and every one of those is
 * something to keep working through future upgrades.
 *
 * `document.execCommand` is deprecated and has no replacement. It is also implemented in every
 * browser, is not going anywhere, and is the only way to apply formatting to a selection without
 * writing a selection model by hand. Writing one by hand for this would be the larger mistake.
 *
 * ## The contract
 *
 * `onChange` reports **sanitised** HTML. The browser's own markup goes through the same filter the
 * API applies, so a paste from Word — which arrives as a cloud of `<font>`, `<o:p>` and inline
 * styles — comes out as the handful of tags the product stores. Paste is intercepted for the same
 * reason: left alone, the browser inserts whatever was on the clipboard, including markup from a
 * page the person had open.
 */
export interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  /** Labels the editing area for a screen reader, and names it in the toolbar's title text. */
  label: string;
  disabled?: boolean;
  /**
   * Put the cursor in the writing area when this mounts.
   *
   * For a dialog whose point is the text. The focus trap otherwise lands on the close button,
   * which is the first focusable thing in a dialog and almost never the one somebody wants.
   */
  autoFocus?: boolean;
  className?: string;
  /** Drawn in the toolbar after the formatting controls, for anything else. */
  actions?: React.ReactNode;
  /**
   * Store a picture somewhere and return the path to put in the text.
   *
   * The editor does not know how a file is stored, and should not: that is a company, a quota, a
   * classification and a malware scan, none of which belong in a formatting control. It asks for
   * a path and inserts it.
   *
   * Omit this and the image button is not drawn, rather than drawn and refusing.
   */
  uploadImage?: (file: File) => Promise<string>;
}

/** The faces offered. A short list: these are set once and read by everybody. */
const FONTS: readonly { label: string; value: string }[] = [
  { label: 'Default', value: '' },
  { label: 'Inter', value: 'Inter, system-ui, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times', value: '"Times New Roman", Times, serif' },
  { label: 'Courier', value: '"Courier New", Courier, monospace' },
];

const SIZES: readonly { label: string; value: string }[] = [
  { label: 'Size', value: '' },
  { label: 'Small', value: '13px' },
  { label: 'Normal', value: '15px' },
  { label: 'Large', value: '19px' },
  { label: 'Heading', value: '24px' },
];

export function RichTextEditor({
  value,
  onChange,
  placeholder,
  label,
  disabled = false,
  autoFocus = false,
  className,
  actions,
  uploadImage,
}: RichTextEditorProps) {
  const area = useRef<HTMLDivElement | null>(null);
  const [empty, setEmpty] = useState(true);
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);

  /*
   * The value is written into the element only when it differs from what is already there.
   *
   * A contentEditable is uncontrolled by nature: writing `innerHTML` on every render puts the
   * caret back at the start, so typing a sentence types it backwards. This syncs on the way in
   * — a value loaded from the server, or cleared — and otherwise leaves the element alone.
   */
  useEffect(() => {
    const node = area.current;
    if (node === null) return;
    const incoming = value ?? '';
    if (node.innerHTML !== incoming) {
      node.innerHTML = incoming;
    }
    setEmpty(node.textContent?.trim() === '');
  }, [value]);

  const publish = (): void => {
    const node = area.current;
    if (node === null) return;
    const clean = sanitiseRichText(node.innerHTML);
    setEmpty(node.textContent?.trim() === '');
    onChange(clean);
  };

  /** Apply a command to the current selection and report the result. */
  const run = (command: string, argument?: string): void => {
    const node = area.current;
    if (node === null || disabled) return;
    node.focus();
    // Deprecated, unreplaced, and implemented everywhere. See the note above.
    document.execCommand(command, false, argument);
    publish();
  };

  const button = (
    command: string,
    icon: Parameters<typeof Icon>[0]['name'],
    title: string,
    argument?: string,
  ): React.ReactNode => (
    <button
      type="button"
      className="uboss-rte-tool"
      title={title}
      aria-label={title}
      disabled={disabled}
      // The press must not take focus from the selection it is about to format.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => run(command, argument)}
    >
      <Icon name={icon} size={15} />
    </button>
  );

  return (
    <div className={cn('uboss-rte', disabled && 'uboss-rte--disabled', className)}>
      <div className="uboss-rte-bar" role="toolbar" aria-label={`${label} formatting`}>
        {button('bold', 'bold', 'Bold')}
        {button('italic', 'italic', 'Italic')}
        {button('underline', 'underline', 'Underline')}
        <span className="uboss-rte-sep" aria-hidden="true" />
        {button('insertUnorderedList', 'list-bullet', 'Bulleted list')}
        {button('insertOrderedList', 'list-numbered', 'Numbered list')}
        <span className="uboss-rte-sep" aria-hidden="true" />

        <select
          className="uboss-rte-pick"
          aria-label={`${label} font`}
          disabled={disabled}
          defaultValue=""
          onMouseDown={(event) => event.stopPropagation()}
          onChange={(event) => {
            const face = event.target.value;
            if (face !== '') run('fontName', face);
            event.target.selectedIndex = 0;
          }}
        >
          {FONTS.map((font) => (
            <option key={font.label} value={font.value}>
              {font.label}
            </option>
          ))}
        </select>

        <select
          className="uboss-rte-pick"
          aria-label={`${label} text size`}
          disabled={disabled}
          defaultValue=""
          onChange={(event) => {
            const size = event.target.value;
            if (size !== '') {
              /*
               * `fontSize` only takes 1–7, which are the old HTML sizes and not what anybody
               * means by "Large". Styling the selection directly is the way to set a real one,
               * and `styleWithCSS` is what makes execCommand write a style rather than a
               * `<font>` tag the sanitiser would then drop.
               */
              document.execCommand('styleWithCSS', false, 'true');
              run('fontSize', '7');
              const node = area.current;
              if (node !== null) {
                node.querySelectorAll('[style*="xxx-large"], font[size="7"]').forEach((found) => {
                  (found as HTMLElement).style.fontSize = size;
                  (found as HTMLElement).removeAttribute('size');
                });
                publish();
              }
            }
            event.target.selectedIndex = 0;
          }}
        >
          {SIZES.map((size) => (
            <option key={size.label} value={size.value}>
              {size.label}
            </option>
          ))}
        </select>

        <label className="uboss-rte-colour" title={`${label} text colour`}>
          <Icon name="palette" size={15} />
          <input
            type="color"
            aria-label={`${label} text colour`}
            disabled={disabled}
            defaultValue="#1f2937"
            onChange={(event) => {
              document.execCommand('styleWithCSS', false, 'true');
              run('foreColor', event.target.value);
            }}
          />
        </label>

        {uploadImage === undefined ? null : (
          <>
            <span className="uboss-rte-sep" aria-hidden="true" />
            <button
              type="button"
              className="uboss-rte-tool"
              title={uploading ? 'Adding the picture…' : 'Add a picture'}
              aria-label="Add a picture"
              disabled={disabled || uploading}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => picker.current?.click()}
            >
              <Icon name="image" size={15} />
            </button>
            <input
              ref={picker}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="uboss-sr-only"
              aria-label={`Add a picture to the ${label}`}
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Cleared so picking the same file twice fires again.
                event.target.value = '';
                if (file === undefined) return;
                setUploading(true);
                void uploadImage(file)
                  .then((src) => {
                    const node = area.current;
                    if (node === null) return;
                    node.focus();
                    /*
                     * Inserted as markup rather than built as a node, so it lands wherever the
                     * caret is — the same place every other command works on. The `alt` is the
                     * file's own name: better than nothing for somebody who cannot see it, and
                     * the only thing we know about the picture.
                     */
                    const alt = file.name.replace(/[<>"&]/g, '').slice(0, 120);
                    document.execCommand('insertHTML', false, `<img src="${src}" alt="${alt}" />`);
                    publish();
                  })
                  .finally(() => setUploading(false));
              }}
            />
          </>
        )}

        {actions === undefined ? null : (
          <>
            <span className="uboss-rte-sep" aria-hidden="true" />
            {actions}
          </>
        )}
      </div>

      <div className="uboss-rte-area-wrap">
        {empty && placeholder !== undefined ? (
          <p className="uboss-rte-placeholder" aria-hidden="true">
            {placeholder}
          </p>
        ) : null}
        <div
          ref={area}
          /*
           * `data-autofocus` when the caller asked for it, which is how `useFocusTrap` is told
           * which control a dialog is actually about.
           *
           * Found in a dialog whose entire purpose is writing: it opened with the cursor on its
           * close button, because the trap takes the first focusable element in DOM order and in
           * every dialog that is the dismiss control. Somebody opened it and typed into nothing.
           */
          {...(autoFocus ? { 'data-autofocus': true } : {})}
          className="uboss-rte-area"
          role="textbox"
          aria-multiline="true"
          aria-label={label}
          contentEditable={!disabled}
          suppressContentEditableWarning
          onInput={publish}
          onBlur={publish}
          /*
           * Paste arrives as whatever was on the clipboard — a Word document is a cloud of
           * `<font>`, `<o:p>` and inline styles, and a copied web page brings that page's markup
           * with it. Taking the plain text and letting the person format it is both safer and
           * what they expect: nobody pastes a Vision in order to keep the other site's fonts.
           */
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData('text/plain');
            document.execCommand('insertText', false, text);
            publish();
          }}
        />
      </div>
    </div>
  );
}

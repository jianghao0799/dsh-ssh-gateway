/** Built-in text editors and session-aware image/PDF previews.
 * Media uses /sidebar/file so both local and SSH sessions share one route.
 * Heavy text editors remain lazy-loaded.
 */
import { IconCodeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { lazyChunkComponent } from '../lazy-chunk.tsx'
import {
  IconMarkdownOutline16,
  IconHtmlOutline16,
} from '../icons.tsx'
import type { ComponentType } from 'react'
import type { FileViewerDescriptor, FileViewerProps } from '../service.ts'
import { t } from '../locales.ts'
import { PdfView } from '../PdfView.tsx'
import { downloadUrl } from '../api.ts'
import css from '../sidebar.module.css'

/**
 * Lazy wrapper over the chunk-resident viewer component. The `pick`
 * function is module-level (stable identity — the wrapper effect depends
 * on it); the cast bridges the chunk exports record to the descriptor prop
 * shape (the view reads only its own subset of FileViewerProps).
 */
const LazyTextEditor = lazyChunkComponent<FileViewerProps>('editor', (mod) => mod.TextEditor as ComponentType<FileViewerProps> | undefined)

/** Built-in file viewer descriptors. */
export function builtinViewers(): readonly FileViewerDescriptor[] {
  return [
    {
      id: 'image',
      title: 'Image',
      exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],
      fetchStrategy: 'mediaUrl',
      component: (props) => (
        <div className={css.editorPdf}>
          <div className={css.editorPdfToolbar}>
            <a className={css.editorDownloadLink} href={downloadUrl(props.scope, props.path)} download>{t('downloadToView')}</a>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'grid', placeItems: 'center' }}>
            <img src={props.mediaUrl} alt={props.title} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          </div>
        </div>
      ),
    },
    {
      id: 'pdf',
      title: 'PDF',
      exts: ['pdf'],
      fetchStrategy: 'none',
      component: (props) => <PdfView scope={props.scope} path={props.path} title={props.title} />,
    },
    {
      id: 'markdown',
      title: () => t('viewerMarkdown'),
      icon: (size: number) => <IconMarkdownOutline16 size={size} />,
      exts: ['md', 'markdown'],
      fetchStrategy: 'fsRead',
      component: (props) => <LazyTextEditor {...props} />,
    },
    {
      id: 'html',
      title: () => t('viewerHtml'),
      icon: (size: number) => <IconHtmlOutline16 size={size} />,
      exts: ['html', 'htm'],
      fetchStrategy: 'fsRead',
      // Declarative settings: the sandbox escape hatch and the default-unsafe
      // start state render under this viewer's row in the Side card settings
      // page (both warned on).
      settings: {
        toggles: [{
          key: 'htmlViewerNoSandbox',
          title: () => t('settingsHtmlSandboxTitle'),
          desc: () => t('settingsHtmlSandboxDesc'),
        }, {
          key: 'htmlViewerDefaultUnsafe',
          title: () => t('settingsHtmlDefaultUnsafeTitle'),
          desc: () => t('settingsHtmlDefaultUnsafeDesc'),
        }],
      },
      component: (props) => <LazyTextEditor {...props} />,
    },
    {
      id: 'jsonl',
      title: () => t('viewerJsonl'),
      icon: (size: number) => <IconCodeOutlineRegular size={size} />,
      // Newline-delimited JSON. It gets its own descriptor rather than riding
      // the `code` catch-all so an external plugin can shadow exactly this
      // format, and so the settings page can switch it off on its own.
      exts: ['jsonl', 'ndjson'],
      priority: 0,
      fetchStrategy: 'fsRead',
      // Same single gutter switch as the code viewer: the editor mode of a
      // JSONL file is still an editable text surface.
      settings: {
        toggles: [{
          key: 'editorGitGutter',
          title: () => t('settingsEditorGitGutterTitle'),
          desc: () => t('settingsEditorGitGutterDesc'),
        }],
      },
      component: (props) => <LazyTextEditor {...props} />,
    },
    {
      id: 'code',
      title: () => t('viewerCode'),
      icon: (size: number) => <IconCodeOutlineRegular size={size} />,
      exts: [],
      priority: -100,
      fetchStrategy: 'fsRead',
      // Declarative settings: ONE switch for the whole uncommitted-change
      // gutter (line tint + left bar + hover blame). Deliberately no
      // per-part switches.
      settings: {
        toggles: [{
          key: 'editorGitGutter',
          title: () => t('settingsEditorGitGutterTitle'),
          desc: () => t('settingsEditorGitGutterDesc'),
        }],
      },
      component: (props) => <LazyTextEditor {...props} />,
    },
  ]
}

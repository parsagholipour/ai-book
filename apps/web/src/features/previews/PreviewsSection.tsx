import { BookOpen, Download, Images, Loader2, MessageSquareText, RefreshCcw } from "lucide-react";
import { apiUrl, type Project, type ProjectDetails } from "../../api.js";

export function PreviewsSection(props: {
  selectedProject: Project;
  selectedDetails: ProjectDetails | null;
  selectedBookMarkdown: string;
  selectedPdfAvailable: boolean;
  selectedPdfPreviewUrl: string;
  coverBusy: boolean;
  selectedId: string | null;
  onRegenerateCover: () => void;
}) {
  const pagePrompts =
    props.selectedDetails?.pages
      .filter((page) => page.imagePrompt?.trim())
      .map((page) => ({ index: page.index, prompt: page.imagePrompt!.trim() })) ?? [];
  const imagePrompts =
    props.selectedDetails?.images
      .filter((image) => image.prompt.trim())
      .map((image) => ({ type: image.type, prompt: image.prompt.trim() })) ?? [];
  const coverImage = props.selectedDetails?.images.find((image) => image.type === "COVER");
  const characterReferenceImages =
    props.selectedDetails?.images.filter((image) => image.type === "CHARACTER_REFERENCE") ?? [];
  const pageImages =
    props.selectedDetails?.images.filter(
      (image) => image.type !== "COVER" && image.type !== "CHARACTER_REFERENCE" && image.type !== "CHARACTER_PROFILE"
    ) ?? [];

  return (
    <section className="preview-grid">
      <div className="preview-images-column">
        <div className="work-section">
          <div className="section-title">
            <Images size={18} />
            <h3>Cover</h3>
            <button
              className="icon-text-button"
              onClick={props.onRegenerateCover}
              disabled={props.coverBusy || !props.selectedId || !props.selectedDetails?.currentPlan}
            >
              {props.coverBusy ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />}
              Regenerate
            </button>
          </div>
          {coverImage ? (
            <figure className="cover-preview">
              <img src={apiUrl(coverImage.path)} alt={coverImage.prompt} />
              <figcaption>Cover PNG</figcaption>
            </figure>
          ) : (
            <div className="cover-placeholder">Cover will appear here after generation.</div>
          )}
        </div>
        <div className="work-section">
          <div className="section-title">
            <Images size={18} />
            <h3>Images</h3>
          </div>
          <div className="image-grid">
            {pageImages.map((image) => (
              <figure key={image.id}>
                <img src={apiUrl(image.path)} alt={image.prompt} />
                <figcaption>{image.type}</figcaption>
              </figure>
            ))}
            {pageImages.length === 0 ? <p className="muted">Page images will appear here after generation.</p> : null}
          </div>
        </div>
        {characterReferenceImages.length > 0 ? (
          <div className="work-section">
            <div className="section-title">
              <Images size={18} />
              <h3>Character References</h3>
            </div>
            <div className="image-grid">
              {characterReferenceImages.map((image) => (
                <figure key={image.id}>
                  <img src={apiUrl(image.path)} alt={image.prompt} />
                  <figcaption>Character reference</figcaption>
                </figure>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="work-section">
        <div className="section-title">
          <BookOpen size={18} />
          <h3>{props.selectedPdfAvailable ? "PDF Preview" : "Markdown Preview"}</h3>
          <a className="icon-text-button" href={apiUrl(`/api/projects/${props.selectedProject.id}/export/readme`)}>
            <Download size={16} />
            Markdown
          </a>
          {props.selectedProject.status === "COMPLETE" || props.selectedPdfAvailable ? (
            <a className="icon-text-button" href={apiUrl(`/api/projects/${props.selectedProject.id}/export/pdf`)}>
              <Download size={16} />
              PDF
            </a>
          ) : null}
        </div>
        {props.selectedPdfAvailable ? (
          <div className="pdf-preview-shell">
            <iframe
              key={props.selectedProject.id}
              className="pdf-preview"
              title={`${props.selectedProject.title} PDF preview`}
              src={props.selectedPdfPreviewUrl}
            />
          </div>
        ) : (
          <pre className="markdown-preview">
            {props.selectedBookMarkdown || "Generated pages will appear here after the first page is saved."}
          </pre>
        )}
      </div>
      <div className="work-section">
        <div className="section-title">
          <MessageSquareText size={18} />
          <h3>Saved prompts</h3>
        </div>
        {pagePrompts.length === 0 && imagePrompts.length === 0 ? (
          <p className="muted">Image and page prompts are saved as generation completes.</p>
        ) : (
          <div className="prompt-log">
            {pagePrompts.map((entry) => (
              <article key={`page-${entry.index}`}>
                <h4>Page {entry.index}</h4>
                <pre>{entry.prompt}</pre>
              </article>
            ))}
            {imagePrompts.map((entry, index) => (
              <article key={`image-${entry.type}-${index}`}>
                <h4>{entry.type}</h4>
                <pre>{entry.prompt}</pre>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

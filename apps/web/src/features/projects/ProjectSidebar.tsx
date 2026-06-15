import type { Dispatch, SetStateAction } from "react";
import {
  Images,
  Info,
  ListChecks,
  Loader2,
  LogOut,
  Plus,
  RefreshCcw,
  Sparkles
} from "lucide-react";
import type { Project, TextModelThinkingEffort } from "../../api.js";
import { formatProjectCost, formatUsd } from "../shared/formatters.js";
import {
  AUDIENCE_AGE_RANGE_OPTIONS,
  CATEGORY_OPTIONS,
  CUSTOM_SUBCATEGORY_VALUE,
  SUBCATEGORY_OPTIONS,
  TONE_PROFILE_OPTIONS,
  audienceAgeRangeFromValue,
  formatRecommendedPageRange,
  imageModelKey,
  imageModelLabel,
  imageModelSelectionFromKey,
  textModelKey,
  textModelLabel,
  textModelSelectionWithEffort,
  textModelSupportsEffort,
  textModelThinkingEffortValue,
  textModelSelectionFromKey,
  toneProfileFromValue,
  type DraftProject,
  type GenerationStrategyOption,
  type ImageModelOption,
  type TextModelOption
} from "./draft.js";
import {
  formatProjectAiModels,
  formatProjectPages,
  projectPopoverPoint,
  projectStrategyLabel,
  projectToneLabel,
  type ProjectHoverState
} from "./projectDisplay.js";
import { AppLogo } from "../shared/AppLogo.js";

export function ProjectSidebar(props: {
  authEnabled: boolean;
  authBusy: boolean;
  draft: DraftProject;
  setDraft: Dispatch<SetStateAction<DraftProject>>;
  projects: Project[];
  selectedId: string | null;
  textModelOptions: TextModelOption[];
  imageModelOptions: ImageModelOption[];
  strategyOptions: GenerationStrategyOption[];
  selectedStrategy: GenerationStrategyOption | undefined;
  selectedTextModel: TextModelOption;
  selectedImageModel: ImageModelOption;
  showImageModelControls: boolean;
  createProjectBusy: boolean;
  onLogout: () => void;
  onCreateProject: () => void;
  onRefreshProjects: () => void;
  onSelectProject: (projectId: string) => void;
  onProjectHoverChange: (projectHover: ProjectHoverState) => void;
}) {
  const subcategoryOptions = SUBCATEGORY_OPTIONS[props.draft.category];

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <AppLogo aria-hidden={true} />
        <div>
          <h1>AI Book Maker</h1>
          <p>Local generation console</p>
        </div>
      </div>
      {props.authEnabled ? (
        <button className="icon-text-button auth-logout" type="button" onClick={props.onLogout} disabled={props.authBusy}>
          {props.authBusy ? <Loader2 className="spin" size={16} /> : <LogOut size={16} />}
          Log out
        </button>
      ) : null}

      <section className="tool-panel">
        <div className="panel-title">
          <Plus size={18} aria-hidden />
          <h2>New Project</h2>
        </div>
        <label>
          Title
          <input value={props.draft.title} onChange={(event) => props.setDraft({ ...props.draft, title: event.target.value })} />
        </label>
        <label>
          Subtitle
          <input value={props.draft.subtitle} onChange={(event) => props.setDraft({ ...props.draft, subtitle: event.target.value })} />
        </label>
        <label>
          Author
          <input
            value={props.draft.authorName}
            onChange={(event) => props.setDraft({ ...props.draft, authorName: event.target.value })}
          />
        </label>
        <label>
          Cover tagline
          <input
            value={props.draft.coverTagline}
            onChange={(event) => props.setDraft({ ...props.draft, coverTagline: event.target.value })}
          />
        </label>
        <label>
          Category
          <select
            value={props.draft.category}
            onChange={(event) => {
              const category = event.target.value as DraftProject["category"];
              props.setDraft({
                ...props.draft,
                category,
                subcategory: "",
                customSubcategory: "",
                lessCensored: category === "KIDS" ? false : props.draft.lessCensored
              });
            }}
          >
            {CATEGORY_OPTIONS.map((category) => (
              <option key={category.value} value={category.value}>
                {category.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Subcategory
          <select
            value={props.draft.subcategory}
            onChange={(event) => props.setDraft({ ...props.draft, subcategory: event.target.value, customSubcategory: "" })}
          >
            <option value="">None</option>
            {subcategoryOptions.map((subcategory) => (
              <option key={subcategory} value={subcategory}>
                {subcategory}
              </option>
            ))}
            <option value={CUSTOM_SUBCATEGORY_VALUE}>Custom</option>
          </select>
        </label>
        {props.draft.subcategory === CUSTOM_SUBCATEGORY_VALUE ? (
          <label>
            Custom subcategory
            <input
              value={props.draft.customSubcategory}
              maxLength={80}
              onChange={(event) => props.setDraft({ ...props.draft, customSubcategory: event.target.value })}
            />
          </label>
        ) : null}
        <label>
          Strategy
          <select
            value={props.draft.generationStrategy}
            onChange={(event) => props.setDraft({ ...props.draft, generationStrategy: event.target.value })}
          >
            {props.strategyOptions.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>
                {strategy.label} — {strategy.strengthScore}/10
              </option>
            ))}
          </select>
          {props.selectedStrategy ? (
            <p className="field-hint strategy-field-hint">
              <span>
                Strength {props.selectedStrategy.strengthScore}/10 — higher scores use more QA passes and tighter
                continuity.
              </span>
              <span className="strategy-info">
                <button
                  type="button"
                  className="strategy-info-trigger"
                  aria-label={`Show recommendation for ${props.selectedStrategy.label}`}
                >
                  <Info size={14} aria-hidden />
                </button>
                <span className="strategy-info-popover" role="tooltip">
                  <span>
                    <strong>Recommended page size</strong>
                    <small>{formatRecommendedPageRange(props.selectedStrategy.recommendedPageRange)}</small>
                  </span>
                  <span>
                    <strong>Accuracy score</strong>
                    <small>{props.selectedStrategy.strengthScore}/10</small>
                  </span>
                </span>
              </span>
            </p>
          ) : null}
        </label>
        <label>
          AI model
          <select
            value={textModelKey(props.selectedTextModel)}
            onChange={(event) =>
              props.setDraft({
                ...props.draft,
                textModel: textModelSelectionFromKey(event.target.value, props.textModelOptions)
              })
            }
          >
            {props.textModelOptions.map((option) => (
              <option key={textModelKey(option)} value={textModelKey(option)}>
                {textModelLabel(option)}
              </option>
            ))}
          </select>
        </label>
        {textModelSupportsEffort(props.selectedTextModel) ? (
          <label>
            Thinking
            <select
              value={textModelThinkingEffortValue(props.draft.textModel, props.selectedTextModel)}
              onChange={(event) =>
                props.setDraft({
                  ...props.draft,
                  textModel: textModelSelectionWithEffort(
                    props.selectedTextModel,
                    event.target.value as TextModelThinkingEffort
                  )
                })
              }
            >
              {props.selectedTextModel.thinkingEfforts.map((effort) => (
                <option key={effort.value} value={effort.value}>
                  {effort.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          Tone
          <select
            value={props.draft.toneProfile}
            onChange={(event) =>
              props.setDraft({ ...props.draft, toneProfile: toneProfileFromValue(event.target.value) })
            }
          >
            {TONE_PROFILE_OPTIONS.map((tone) => (
              <option key={tone.id} value={tone.id}>
                {tone.label} — {tone.hint}
              </option>
            ))}
          </select>
        </label>
        <label>
          First prompt
          <textarea
            rows={5}
            value={props.draft.prompt}
            onChange={(event) => props.setDraft({ ...props.draft, prompt: event.target.value })}
          />
        </label>
        {props.draft.category === "KIDS" ? (
          <label>
            Age range
            <select
              value={props.draft.audienceAgeRange}
              onChange={(event) =>
                props.setDraft({ ...props.draft, audienceAgeRange: audienceAgeRangeFromValue(event.target.value) })
              }
            >
              {AUDIENCE_AGE_RANGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="two-col">
          <label>
            Pages
            <input
              type="number"
              min={1}
              max={600}
              value={props.draft.targetPages}
              onChange={(event) => props.setDraft({ ...props.draft, targetPages: Number(event.target.value) })}
            />
          </label>
          <label>
            Complexity
            <input
              type="range"
              min={1}
              max={10}
              value={props.draft.complexity}
              onChange={(event) => props.setDraft({ ...props.draft, complexity: Number(event.target.value) })}
            />
          </label>
        </div>
        <div className="two-col">
          <label>
            Temperature (0-2)
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={props.draft.temperature}
              onChange={(event) => props.setDraft({ ...props.draft, temperature: Number(event.target.value) })}
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={props.draft.fullIllustrations}
              onChange={(event) => props.setDraft({ ...props.draft, fullIllustrations: event.target.checked })}
            />
            Images
          </label>
        </div>
        {props.showImageModelControls ? (
          <>
            <label>
              Image model
              <select
                value={imageModelKey(props.selectedImageModel)}
                onChange={(event) =>
                  props.setDraft({
                    ...props.draft,
                    imageModel: imageModelSelectionFromKey(event.target.value, props.imageModelOptions)
                  })
                }
              >
                {props.imageModelOptions.map((option) => (
                  <option key={imageModelKey(option)} value={imageModelKey(option)}>
                    {imageModelLabel(option)}
                  </option>
                ))}
              </select>
            </label>
            {!props.selectedImageModel.supportsReferenceImages ? (
              <p className="field-hint">
                This image model does not use character reference sheets, so recurring character consistency may be
                weaker.
              </p>
            ) : null}
          </>
        ) : null}
        <div className="two-col">
          <label className="check-row">
            <input
              type="checkbox"
              checked={props.draft.includeCover}
              onChange={(event) => props.setDraft({ ...props.draft, includeCover: event.target.checked })}
            />
            Cover
          </label>
          <label>
            Cover template
            <select
              value={props.draft.coverTemplate}
              onChange={(event) =>
                props.setDraft({ ...props.draft, coverTemplate: event.target.value as DraftProject["coverTemplate"] })
              }
            >
              <option value="auto">Auto</option>
              <option value="kids">Kids</option>
              <option value="science">Science</option>
              <option value="fiction">Fiction</option>
              <option value="minimal">Minimal</option>
              <option value="business">Business</option>
              <option value="self-help">Self-help</option>
              <option value="romance">Romance</option>
            </select>
          </label>
        </div>
        <label>
          Best-of drafting
          <select
            value={String(props.draft.draftCandidates)}
            onChange={(event) =>
              props.setDraft({ ...props.draft, draftCandidates: Number.parseInt(event.target.value, 10) || 1 })
            }
          >
            <option value="1">Off — single draft per page</option>
            <option value="2">2 drafts + judge (higher quality)</option>
            <option value="3">3 drafts + judge (best quality)</option>
          </select>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={props.draft.finalReview}
            onChange={(event) => props.setDraft({ ...props.draft, finalReview: event.target.checked })}
          />
          Final review before export
        </label>
        {props.draft.category !== "KIDS" ? (
          <label className="check-row">
            <input
              type="checkbox"
              checked={props.draft.lessCensored}
              onChange={(event) => props.setDraft({ ...props.draft, lessCensored: event.target.checked })}
            />
            Direct phrasing for mature topics
          </label>
        ) : null}
        {props.draft.category !== "KIDS" && props.draft.lessCensored ? (
          <p className="field-hint">
            Uses clearer drafting prompts for allowed mature topics. Safety filters and provider policy still apply.
          </p>
        ) : null}
        <button className="primary-button" onClick={props.onCreateProject} disabled={props.createProjectBusy || props.draft.prompt.length < 10}>
          {props.createProjectBusy ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
          Create & Plan
        </button>
      </section>

      <section className="project-list">
        <div className="panel-title">
          <ListChecks size={18} aria-hidden />
          <h2>Projects</h2>
          <button className="icon-button" onClick={props.onRefreshProjects} title="Refresh projects">
            <RefreshCcw size={16} />
          </button>
        </div>
        {props.projects.map((project) => (
          <button
            key={project.id}
            className={project.id === props.selectedId ? "project-button active" : "project-button"}
            onClick={() => props.onSelectProject(project.id)}
            onBlur={() => props.onProjectHoverChange(null)}
            onFocus={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              props.onProjectHoverChange({ project, ...projectPopoverPoint(rect.right - 20, rect.bottom - 8) });
            }}
            onMouseEnter={(event) =>
              props.onProjectHoverChange({ project, ...projectPopoverPoint(event.clientX, event.clientY) })
            }
            onMouseLeave={() => props.onProjectHoverChange(null)}
            onMouseMove={(event) =>
              props.onProjectHoverChange({ project, ...projectPopoverPoint(event.clientX, event.clientY) })
            }
          >
            <div className="project-button-summary">
              <div className="project-button-main">
                <span className="project-button-title">{project.title}</span>
                <small>{project.status}</small>
              </div>
              <small className="project-cost-summary">{formatProjectCost(project.cost)}</small>
            </div>
            <small className="project-model-summary">
              {formatProjectAiModels(project, props.textModelOptions, props.imageModelOptions)}
            </small>
          </button>
        ))}
      </section>
    </aside>
  );
}

export function ProjectHoverPopover(props: {
  projectHover: ProjectHoverState;
  strategyOptions: GenerationStrategyOption[];
}) {
  return props.projectHover ? (
    <div className="project-hover-popover" style={{ left: props.projectHover.x, top: props.projectHover.y }} role="tooltip">
      <span>
        <strong>Strategy</strong>
        <small>{projectStrategyLabel(props.projectHover.project, props.strategyOptions)}</small>
      </span>
      <span>
        <strong>Tone</strong>
        <small>{projectToneLabel(props.projectHover.project)}</small>
      </span>
      <span>
        <strong>Pages</strong>
        <small>{formatProjectPages(props.projectHover.project)}</small>
      </span>
      <span>
        <strong>Text cost</strong>
        <small>{formatUsd(props.projectHover.project.cost?.textUsd)}</small>
      </span>
      <span>
        <strong>Image cost</strong>
        <small>{formatUsd(props.projectHover.project.cost?.imageUsd)}</small>
      </span>
      <span>
        <strong>Total</strong>
        <small>{formatUsd(props.projectHover.project.cost?.totalUsd)}</small>
      </span>
    </div>
  ) : null;
}

import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  CircleStop,
  Loader2,
  RefreshCcw,
  Sparkles,
  XCircle
} from "lucide-react";
import type { GenerationJobRow, JobStep, PipelineStep, ProjectStatus } from "../../api.js";
import { resolveJobDisplaySteps, resolvePipelineSteps } from "../../jobsDisplay.js";
import {
  formatDuration,
  formatJobTiming,
  formatProviderModel,
  formatTokenPair,
  hasProviderDuration
} from "../shared/formatters.js";
import type { GenerationStrategyOption } from "../projects/draft.js";
import { Button } from "../shared/Button.js";

export function JobsSection(props: {
  selectedStatus: ProjectStatus | null;
  selectedId: string | null;
  activeGenerationStrategy: GenerationStrategyOption;
  canStopProject: boolean;
  canRetryPlanning: boolean;
  canResumeProject: boolean;
  stopBusy: boolean;
  resumeBusy: boolean;
  onStopProject: () => void;
  onResumeProject: () => void;
}) {
  const recoveryLabel = props.canRetryPlanning ? "Retry" : "Resume";
  const recoveryLoadingLabel = props.canRetryPlanning ? "Retrying…" : "Resuming…";

  return (
    <section className="work-section">
      <div className="section-title">
        <CheckCircle2 size={18} />
        <h3>Jobs</h3>
        {props.canStopProject || props.canResumeProject ? (
          <div className="job-controls">
            {props.canStopProject ? (
              <Button
                variant="danger"
                size="sm"
                onClick={props.onStopProject}
                disabled={props.stopBusy || !props.selectedId}
                loading={props.stopBusy}
                loadingLabel="Stopping…"
                startIcon={<CircleStop />}
              >
                Stop
              </Button>
            ) : null}
            {props.canResumeProject ? (
              <Button
                variant="accent"
                size="sm"
                onClick={props.onResumeProject}
                disabled={props.resumeBusy || !props.selectedId}
                loading={props.resumeBusy}
                loadingLabel={recoveryLoadingLabel}
                startIcon={<RefreshCcw />}
              >
                {recoveryLabel}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="job-strategy-summary">
        <Sparkles size={16} aria-hidden />
        <div>
          <span>Strategy</span>
          <strong>{props.activeGenerationStrategy.label}</strong>
        </div>
        <small>Strength {props.activeGenerationStrategy.strengthScore}/10</small>
      </div>
      <div className="pipeline-stepper">
        {resolvePipelineSteps(props.selectedStatus).map((step, index, steps) => (
          <PipelineStepItem key={step.key} step={step} isLast={index === steps.length - 1} />
        ))}
      </div>
      <div className="jobs-list">
        {props.selectedStatus?.project.jobs.map((job) => (
          <JobRow key={job.id} job={job} />
        ))}
      </div>
    </section>
  );
}

function PipelineStepItem(props: { step: PipelineStep; isLast: boolean }) {
  const icon =
    props.step.status === "active" ? (
      <Loader2 className="spin pipeline-icon" size={14} />
    ) : props.step.status === "done" ? (
      <CheckCircle2 className="pipeline-icon done" size={14} />
    ) : props.step.status === "failed" ? (
      <XCircle className="pipeline-icon failed" size={14} />
    ) : (
      <Circle className="pipeline-icon pending" size={14} />
    );

  return (
    <div className={`pipeline-step status-${props.step.status}${props.isLast ? " last" : ""}`}>
      {icon}
      <div className="pipeline-step-body">
        <strong>{props.step.label}</strong>
        {props.step.detail ? <small>{props.step.detail}</small> : null}
      </div>
    </div>
  );
}

function JobRow(props: { job: GenerationJobRow }) {
  const { job } = props;
  const steps = resolveJobDisplaySteps(job);
  const statusClass = job.status.toLowerCase();

  return (
    <div className={`job-row status-${statusClass}`}>
      <div className="job-row-header">
        <div className="job-title">
          {job.type === "GENERATE_PAGE" && typeof job.pageIndex === "number" ? (
            <span className="job-page-badge" title={`Page ${job.pageIndex}`} aria-label={`Page ${job.pageIndex}`}>
              {job.pageIndex}
            </span>
          ) : null}
          <span className="job-type">{job.type}</span>
        </div>
        <span className={`job-status-pill status-${statusClass}`}>
          {job.status === "ACTIVE" ? <Loader2 className="spin" size={12} /> : null}
          {job.status}
        </span>
      </div>
      <div className="job-progress-bar">
        <div style={{ width: `${Math.min(100, Math.max(0, job.progress))}%` }} />
      </div>
      <small className="job-message">{job.error ?? job.message ?? `${job.progress}%`}</small>
      <small className="job-token-usage">{formatTokenPair(job.tokens)}</small>
      {hasProviderDuration(job.providerDurationMs) ? (
        <small className="job-provider-duration">Provider {formatDuration(job.providerDurationMs)}</small>
      ) : null}
      {job.startedAt || job.finishedAt ? (
        <small className="job-timing">{formatJobTiming(job.startedAt, job.finishedAt)}</small>
      ) : null}
      {job.imageFallbacks?.length ? (
        <div className="job-fallbacks">
          {job.imageFallbacks.map((detail, index) => (
            <JobImageFallbackDetail key={`${detail.occurredAt ?? detail.status}-${index}`} detail={detail} />
          ))}
        </div>
      ) : null}
      {steps.length > 0 ? (
        <ul className={`job-steps${job.status === "ACTIVE" ? " expanded" : ""}`}>
          {steps.map((step) => (
            <JobStepItem key={step.key} step={step} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function JobImageFallbackDetail(props: { detail: NonNullable<GenerationJobRow["imageFallbacks"]>[number] }) {
  const { detail } = props;
  const statusLabel =
    detail.status === "used" ? "Fallback used" : detail.status === "failed" ? "Fallback failed" : "Fallback trying";
  const result = detail.result ?? (detail.status === "used" ? detail.fallback : undefined);

  return (
    <div className={`job-fallback-detail status-${detail.status}`}>
      <div className="job-fallback-heading">
        <AlertTriangle size={13} />
        <strong>{statusLabel}</strong>
        {result ? <span>{formatProviderModel(result)}</span> : <span>{formatProviderModel(detail.fallback)}</span>}
      </div>
      <small>Primary {formatProviderModel(detail.primary)}</small>
      {detail.primary.error ? <small>Primary error: {detail.primary.error}</small> : null}
      {detail.fallback.error ? <small>Fallback error: {detail.fallback.error}</small> : null}
    </div>
  );
}

function JobStepItem(props: { step: JobStep }) {
  const icon =
    props.step.status === "active" ? (
      <Loader2 className="spin" size={12} />
    ) : props.step.status === "done" ? (
      <CheckCircle2 size={12} />
    ) : props.step.status === "failed" ? (
      <XCircle size={12} />
    ) : (
      <Circle size={12} />
    );

  return (
    <li className={`job-step status-${props.step.status}`}>
      {icon}
      <span>{props.step.label}</span>
    </li>
  );
}

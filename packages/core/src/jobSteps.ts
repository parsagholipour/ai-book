export type JobStepStatus = "pending" | "active" | "done" | "failed";

/**
 * One milestone of a running job.
 *
 * `label` is worker vocabulary and never reaches a reader — the mobile
 * serializers map `key` through their own copy table instead. The optional
 * fields below are what lets that rule hold while the app still shows real
 * detail: they are numbers and enum-ish tokens rather than prose, so the API
 * can spend them on reader-facing text ("3 of 7 pages", "Checking page 12")
 * without the worker ever choosing the words.
 */
export type JobStep = {
  key: string;
  label: string;
  status: JobStepStatus;
  /** Units of work finished inside this step, when it counts units at all. */
  done?: number;
  /** How many units this step will finish in total. */
  total?: number;
  /** Which part of the current unit is running, e.g. "draft" | "review" | "save". */
  phase?: string;
  /** The book page the current unit is working on. */
  pageIndex?: number;
};

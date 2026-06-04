export type JobStepStatus = "pending" | "active" | "done" | "failed";

export type JobStep = {
  key: string;
  label: string;
  status: JobStepStatus;
};

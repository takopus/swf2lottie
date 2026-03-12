export type IssueSeverity = "error" | "warning";

export type IssueCode =
  | "unsupported_tag"
  | "unsupported_feature"
  | "unsupported_fill"
  | "unsupported_mask"
  | "unsupported_color_transform"
  | "malformed_swf"
  | "not_implemented";

export interface ConversionIssue {
  code: IssueCode;
  severity: IssueSeverity;
  message: string;
  path?: string;
  details?: Record<string, unknown>;
}

export class ConversionError extends Error {
  public readonly issues: ConversionIssue[];

  public constructor(message: string, issues: ConversionIssue[]) {
    super(message);
    this.name = "ConversionError";
    this.issues = issues;
  }
}

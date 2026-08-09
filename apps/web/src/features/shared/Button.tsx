import {
  forwardRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ReactNode
} from "react";
import { Loader2 } from "lucide-react";
import { Link, type LinkProps } from "react-router";

export type ActionVariant = "primary" | "secondary" | "accent" | "danger";
export type ActionSize = "sm" | "md";

type ActionStyleProps = {
  variant?: ActionVariant;
  size?: ActionSize;
  fullWidth?: boolean;
  compact?: boolean;
  startIcon?: ReactNode;
  endIcon?: ReactNode;
};

export type ButtonProps = ActionStyleProps &
  ButtonHTMLAttributes<HTMLButtonElement> & {
    loading?: boolean;
    loadingLabel?: ReactNode;
  };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    fullWidth = false,
    compact = false,
    loading = false,
    loadingLabel,
    startIcon,
    endIcon,
    className,
    children,
    disabled,
    type = "button",
    ...buttonProps
  },
  ref
) {
  return (
    <button
      {...buttonProps}
      ref={ref}
      type={type}
      className={actionClassName("action-button", variant, size, fullWidth, compact, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      <ActionContent
        loading={loading}
        loadingLabel={loadingLabel}
        startIcon={startIcon}
        endIcon={endIcon}
      >
        {children}
      </ActionContent>
    </button>
  );
});

export type IconButtonProps = Omit<
  ButtonProps,
  "aria-label" | "children" | "fullWidth" | "compact" | "startIcon" | "endIcon"
> & {
  label: string;
  children: ReactNode;
  loadingLabel?: string;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, loading = false, loadingLabel, children, className, ...buttonProps },
  ref
) {
  return (
    <Button
      {...buttonProps}
      ref={ref}
      className={joinClassNames("action-icon-button", className)}
      loading={loading}
      aria-label={loading && loadingLabel ? loadingLabel : label}
    >
      {loading ? null : children}
    </Button>
  );
});

type ButtonLinkStyleProps = ActionStyleProps & {
  className?: string;
  children?: ReactNode;
};

type RouterButtonLinkProps = ButtonLinkStyleProps &
  Omit<LinkProps, keyof ButtonLinkStyleProps | "href"> & {
    href?: never;
  };

type AnchorButtonLinkProps = ButtonLinkStyleProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof ButtonLinkStyleProps | "href"> & {
    href: string;
    to?: never;
  };

export type ButtonLinkProps = RouterButtonLinkProps | AnchorButtonLinkProps;

export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink(
  props,
  ref
) {
  const {
    variant = "secondary",
    size = "md",
    fullWidth = false,
    compact = false,
    startIcon,
    endIcon,
    className,
    children
  } = props;
  const actionClass = actionClassName("action-button", variant, size, fullWidth, compact, className);
  const content = (
    <ActionContent loading={false} startIcon={startIcon} endIcon={endIcon}>
      {children}
    </ActionContent>
  );

  if ("href" in props) {
    const {
      variant: _variant,
      size: _size,
      fullWidth: _fullWidth,
      compact: _compact,
      startIcon: _startIcon,
      endIcon: _endIcon,
      className: _className,
      children: _children,
      ...anchorProps
    } = props;
    return (
      <a {...anchorProps} ref={ref} className={actionClass}>
        {content}
      </a>
    );
  }

  const {
    variant: _variant,
    size: _size,
    fullWidth: _fullWidth,
    compact: _compact,
    startIcon: _startIcon,
    endIcon: _endIcon,
    className: _className,
    children: _children,
    ...linkProps
  } = props;
  return (
    <Link {...linkProps} ref={ref} className={actionClass}>
      {content}
    </Link>
  );
});

function ActionContent(props: {
  loading: boolean;
  loadingLabel?: ReactNode;
  startIcon?: ReactNode;
  endIcon?: ReactNode;
  children: ReactNode;
}) {
  const showStart = props.loading || props.startIcon;
  return (
    <>
      {showStart ? (
        <span className="action-control-icon" aria-hidden="true">
          {props.loading ? <Loader2 className="action-spinner" /> : props.startIcon}
        </span>
      ) : null}
      {props.loading && props.loadingLabel !== undefined ? props.loadingLabel : props.children}
      {!props.loading && props.endIcon ? (
        <span className="action-control-icon" aria-hidden="true">
          {props.endIcon}
        </span>
      ) : null}
    </>
  );
}

function actionClassName(
  base: string,
  variant: ActionVariant,
  size: ActionSize,
  fullWidth: boolean,
  compact: boolean,
  className: string | undefined
): string {
  return joinClassNames(
    "action-control",
    base,
    `action-control--${variant}`,
    `action-control--${size}`,
    fullWidth ? "action-control--full-width" : undefined,
    compact ? "action-control--compact" : undefined,
    className
  );
}

function joinClassNames(...classNames: Array<string | undefined>): string {
  return classNames.filter(Boolean).join(" ");
}

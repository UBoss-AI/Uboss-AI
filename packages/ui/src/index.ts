/**
 * @uboss/ui — the UBoss design system.
 *
 * Import the stylesheet once at the application root:
 *   import '@uboss/ui/styles.css';
 *
 * Screens must compose these components rather than styling themselves (locked UI rule:
 * reusable components, not one-off page styling).
 */

/* ---- Utilities ---- */
export { cn } from './lib/class-names';
export type { ClassValue } from './lib/class-names';
export { useFocusTrap } from './lib/use-focus-trap';

/* ---- Primitives ---- */
export { Icon, ICON_NAMES } from './primitives/Icon';
export type { IconName, IconProps } from './primitives/Icon';

export { Button } from './primitives/Button';
export type { ButtonProps, ButtonVariant } from './primitives/Button';

export { Card, CardBody, CardHeader } from './primitives/Card';
export type { CardBodyProps, CardHeaderProps, CardProps } from './primitives/Card';

export { Breadcrumbs } from './primitives/Breadcrumbs';
export type { BreadcrumbsProps, Crumb } from './primitives/Breadcrumbs';

export { PageHeader } from './primitives/PageHeader';
export type { PageHeaderProps } from './primitives/PageHeader';

export { MetricCard } from './primitives/MetricCard';
export type { MetricCardProps, MetricTrend } from './primitives/MetricCard';

export { BADGE_LADDER, MedalBadge, STATUS_TONES, StatusBadge } from './primitives/StatusBadge';
export type {
  BadgeLadderTier,
  MedalBadgeProps,
  StatusBadgeProps,
  StatusTone,
} from './primitives/StatusBadge';

export { BadgeProgression } from './primitives/BadgeProgression';
export type { BadgeProgressionProps } from './primitives/BadgeProgression';

export { DataTable } from './primitives/DataTable';
export type { DataTableColumn, DataTableProps } from './primitives/DataTable';

export { FilterBar, FilterSelect } from './primitives/FilterBar';
export type { FilterBarProps, FilterOption, FilterSelectProps } from './primitives/FilterBar';

export { SearchField } from './primitives/SearchField';
export type { SearchFieldProps } from './primitives/SearchField';

export { TabPanel, Tabs } from './primitives/Tabs';
export type { TabItem, TabPanelProps, TabsProps } from './primitives/Tabs';

export { Drawer } from './primitives/Drawer';
export type { DrawerProps } from './primitives/Drawer';

export { Modal } from './primitives/Modal';
export type { ModalProps } from './primitives/Modal';

export { ConfirmDialog } from './primitives/ConfirmDialog';
export type { ConfirmDialogProps, ImpactLine } from './primitives/ConfirmDialog';

export { FormField } from './primitives/FormField';
export type { FormFieldProps } from './primitives/FormField';

export { EmptyState } from './primitives/EmptyState';
export type { EmptyStateProps } from './primitives/EmptyState';

export { Banner, ErrorState } from './primitives/ErrorState';
export type {
  BannerProps,
  BannerTone,
  ErrorStateKind,
  ErrorStateProps,
} from './primitives/ErrorState';

export { Skeleton, SkeletonText } from './primitives/Skeleton';
export type { SkeletonProps, SkeletonTextProps } from './primitives/Skeleton';

export { ProgressStep } from './primitives/ProgressStep';
export type { ProgressStepItem, ProgressStepProps, StepState } from './primitives/ProgressStep';

export { ApprovalCard } from './primitives/ApprovalCard';
export type { ApprovalCardProps } from './primitives/ApprovalCard';

export { CreditMeter } from './primitives/CreditMeter';
export type { CreditLifecycle, CreditMeterProps } from './primitives/CreditMeter';

export { SecurityMetric } from './primitives/SecurityMetric';
export type { SecurityLevel, SecurityMetricProps } from './primitives/SecurityMetric';

export { DonutDashboard } from './primitives/DonutDashboard';

// Prompt 12 — the Organization Hierarchy pieces, from the approved reference.
export { VisionMission } from './primitives/VisionMission';
export type { VisionMissionProps } from './primitives/VisionMission';

export { SegmentedControl } from './primitives/SegmentedControl';
export type { SegmentedControlProps, SegmentedOption } from './primitives/SegmentedControl';

export { OrgChart } from './primitives/OrgChart';
export type { OrgChartNode, OrgChartProps } from './primitives/OrgChart';
export type { DonutDashboardProps } from './primitives/DonutDashboard';

/* ---- Shells ---- */
export { AppShell } from './shells/AppShell';
export type { AppShellProps } from './shells/AppShell';

export { Sidebar } from './shells/Sidebar';
export type { SidebarProps, SidebarUser } from './shells/Sidebar';

export { COMPANY_HEADER_PREFIX, MASTER_HEADER_LABEL, TopBar } from './shells/TopBar';
export type { TopBarProps } from './shells/TopBar';

export { SettingsShell } from './shells/SettingsShell';
export type { SettingsShellProps } from './shells/SettingsShell';

export { LoginPresentation, NoPublicSignupNotice } from './shells/LoginPresentation';
export type { LoginPresentationProps } from './shells/LoginPresentation';

/* ---- Navigation models (mock at Prompt 2; permissions resolve server-side) ---- */
export {
  COMPANY_NAV,
  filterNavigation,
  LOGIN_ASSURANCES,
  LOGIN_CAPABILITIES,
  MASTER_NAV,
  SETTINGS_SECTIONS,
} from './navigation/navigation-model';
export type {
  LoginAssurance,
  LoginCapability,
  NavGroup,
  NavItem,
  SettingsSection,
} from './navigation/navigation-model';

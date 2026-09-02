import { Combobox, type ControlOption } from './SelectCombobox';

export interface CategoryOption {
  value: string;
  group: string;
  name: string;
  sug: boolean;
}

type CategoryPickerProps = {
  label: string;
  value: string | null;
  onPick: (value: string) => void;
  options: readonly CategoryOption[];
  onSplitFooter?: () => void;
  showBadges: boolean;
  disabled?: boolean;
  triggerText?: string;
  triggerTone?: 'suggested';
  triggerBadge?: string;
  triggerBadgeTooltip?: string;
};
export default function CategoryPicker(props: CategoryPickerProps) {
  const {
    label,
    value,
    onPick,
    options,
    onSplitFooter,
    showBadges,
    disabled = false,
    triggerText,
    triggerTone,
    triggerBadge,
    triggerBadgeTooltip,
  } = props;
  const controlOptions: ControlOption[] = options.map(({ value: optionValue, group, name }) => ({
    value: optionValue,
    label: `${group} · ${name}`,
    group,
    searchText: `${group} ${name}`,
  }));

  return (
    <span className="category-picker">
      <Combobox
        label={label}
        value={value}
        options={controlOptions}
        onValueChange={(next) => { if (next !== null) onPick(next); }}
        disabled={disabled}
        placeholder={triggerText}
        className={triggerTone === 'suggested' ? 'category-picker-suggested' : undefined}
        searchPlaceholder="Search categories…"
        emptyText="No matching categories"
        renderOption={(option) => {
          const source = options.find((entry) => entry.value === option.value)!;
          return <><span><span className="control-option-group">{source.group} · </span>{source.name}</span>{showBadges && source.sug && <span className="control-option-suggestion">suggested</span>}</>;
        }}
        footer={onSplitFooter ? <button type="button" className="control-footer" onClick={onSplitFooter}>Split into multiple categories →</button> : undefined}
      />
      {triggerBadge && (
        <span
          data-tip={triggerBadgeTooltip}
          style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--amT)', marginLeft: 7 }}
        >
          {triggerBadge}
        </span>
      )}
    </span>
  );
}

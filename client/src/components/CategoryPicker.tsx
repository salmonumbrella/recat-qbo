import { Combobox, type ControlOption } from './SelectCombobox';
import { useEffect, useRef } from 'react';
import type { CSSProperties, MouseEvent } from 'react';

export interface CategoryOption {
  value: string;
  group: string;
  name: string;
  sug: boolean;
}

type StableCategoryPickerProps = {
  label: string;
  value: string | null;
  onPick: (value: string) => void;
  options: readonly CategoryOption[];
  onSplitFooter?: () => void;
  showBadges: boolean;
  disabled?: boolean;
};

// Temporary Queue compatibility; Task 3 removes this after its stable-value migration.
export type LegacyCategoryOption = Omit<CategoryOption, 'value'>;

type LegacyCategoryPickerProps = {
  query: string;
  onQueryChange: (value: string) => void;
  options: readonly LegacyCategoryOption[];
  empty: boolean;
  activeIdx: number;
  onPick: (name: string) => void;
  onSplitFooter?: () => void;
  showBadges: boolean;
  containerStyle: CSSProperties;
};

function LegacyCategoryPicker({
  query,
  onQueryChange,
  options,
  empty,
  activeIdx,
  onPick,
  onSplitFooter,
  showBadges,
  containerStyle,
}: LegacyCategoryPickerProps) {
  const stop = (event: MouseEvent) => event.stopPropagation();
  const listRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const activeOption = listRef.current?.children[activeIdx] as HTMLElement | undefined;
    activeOption?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIdx]);

  return (
    <span onClick={stop} onMouseDown={stop} style={{ position: 'absolute', left: 0, ...containerStyle }}>
      <input autoFocus value={query} aria-label="Search categories" onChange={(event) => onQueryChange(event.target.value)} />
      <span ref={listRef} style={{ display: 'block', maxHeight: 246, overflow: 'auto' }}>
        {options.map((option, index) => (
          <button
            key={`${option.group}·${option.name}`}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onPick(option.name);
            }}
            style={{ display: 'flex', justifyContent: 'space-between', width: '100%', background: index === activeIdx ? 'var(--hl)' : 'transparent' }}
          >
            <span><span className="control-option-group">{option.group} · </span>{option.name}</span>
            {showBadges && option.sug && <span className="control-option-suggestion">suggested</span>}
          </button>
        ))}
        {empty && <span className="control-empty">No matching categories</span>}
      </span>
      {onSplitFooter && <button type="button" className="control-footer" onClick={(event) => { event.stopPropagation(); onSplitFooter(); }}>Split into multiple categories →</button>}
    </span>
  );
}

export default function CategoryPicker(props: StableCategoryPickerProps | LegacyCategoryPickerProps) {
  if ('query' in props) return <LegacyCategoryPicker {...props} />;

  const {
    label,
    value,
    onPick,
    options,
    onSplitFooter,
    showBadges,
    disabled = false,
  } = props;
  const controlOptions: ControlOption[] = options.map(({ value: optionValue, group, name }) => ({
    value: optionValue,
    label: `${group} · ${name}`,
    group,
    searchText: `${group} ${name}`,
  }));

  return (
    <Combobox
      label={label}
      value={value}
      options={controlOptions}
      onValueChange={(next) => { if (next !== null) onPick(next); }}
      disabled={disabled}
      searchPlaceholder="Search categories…"
      emptyText="No matching categories"
      renderOption={(option) => {
        const source = options.find((entry) => entry.value === option.value)!;
        return <><span><span className="control-option-group">{source.group} · </span>{source.name}</span>{showBadges && source.sug && <span className="control-option-suggestion">suggested</span>}</>;
      }}
      footer={onSplitFooter ? <button type="button" className="control-footer" onClick={onSplitFooter}>Split into multiple categories →</button> : undefined}
    />
  );
}

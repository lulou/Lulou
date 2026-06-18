import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUnits } from "@/lib/units";

function generateOptions(units: string): { value: string; label: string }[] {
  const opts: { value: string; label: string }[] = [];
  if (units === "imperial") {
    for (let totalIn = 55; totalIn <= 87; totalIn++) {
      const ft = Math.floor(totalIn / 12);
      const ins = totalIn % 12;
      const label = `${ft}'${ins}"`;
      opts.push({ value: label, label });
    }
  } else {
    for (let cm = 140; cm <= 220; cm++) {
      opts.push({ value: `${cm} cm`, label: `${cm} cm` });
    }
  }
  return opts;
}

export function HeightPicker({
  value,
  onChange,
  placeholder,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  testId?: string;
}) {
  const [units] = useUnits();
  const options = generateOptions(units);
  const matched = options.some(o => o.value === value);

  return (
    <Select value={matched ? value : ""} onValueChange={onChange}>
      <SelectTrigger data-testid={testId ?? "select-height"}>
        <SelectValue placeholder={placeholder ?? "Select height (optional)"} />
      </SelectTrigger>
      <SelectContent className="max-h-64 overflow-y-auto">
        {options.map(o => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

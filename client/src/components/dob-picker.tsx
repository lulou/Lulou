import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface DobPickerProps {
  value: string;
  onChange: (v: string) => void;
  testIdPrefix?: string;
}

const MONTHS = [
  { v: "01", label: "January" },
  { v: "02", label: "February" },
  { v: "03", label: "March" },
  { v: "04", label: "April" },
  { v: "05", label: "May" },
  { v: "06", label: "June" },
  { v: "07", label: "July" },
  { v: "08", label: "August" },
  { v: "09", label: "September" },
  { v: "10", label: "October" },
  { v: "11", label: "November" },
  { v: "12", label: "December" },
];

function daysInMonth(year: string, month: string): number {
  if (!year || !month) return 31;
  return new Date(parseInt(year), parseInt(month), 0).getDate();
}

export function DobPicker({ value, onChange, testIdPrefix = "dob" }: DobPickerProps) {
  const m = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const [year, setYear] = useState(m?.[1] ?? "");
  const [month, setMonth] = useState(m?.[2] ?? "");
  const [day, setDay] = useState(m?.[3] ?? "");

  const emit = (y: string, mo: string, d: string) => {
    if (y && mo && d) onChange(`${y}-${mo}-${d}`);
    else onChange("");
  };

  const handleYear = (y: string) => {
    setYear(y);
    const maxDay = daysInMonth(y, month);
    const safeDay = day && parseInt(day) > maxDay ? "" : day;
    if (safeDay !== day) setDay(safeDay);
    emit(y, month, safeDay);
  };

  const handleMonth = (mo: string) => {
    setMonth(mo);
    const maxDay = daysInMonth(year, mo);
    const safeDay = day && parseInt(day) > maxDay ? "" : day;
    if (safeDay !== day) setDay(safeDay);
    emit(year, mo, safeDay);
  };

  const handleDay = (d: string) => {
    setDay(d);
    emit(year, month, d);
  };

  const currentYear = new Date().getFullYear();
  const maxYear = currentYear - 18;
  const minYear = currentYear - 100;
  const years = Array.from({ length: maxYear - minYear + 1 }, (_, i) => maxYear - i);
  const dayCount = daysInMonth(year, month);

  return (
    <div className="flex gap-2">
      <Select value={day} onValueChange={handleDay}>
        <SelectTrigger className="w-[72px]" data-testid={`select-${testIdPrefix}-day`}>
          <SelectValue placeholder="Day" />
        </SelectTrigger>
        <SelectContent>
          {Array.from({ length: dayCount }, (_, i) => {
            const d = String(i + 1).padStart(2, "0");
            return (
              <SelectItem key={d} value={d}>
                {i + 1}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>

      <Select value={month} onValueChange={handleMonth}>
        <SelectTrigger className="flex-1" data-testid={`select-${testIdPrefix}-month`}>
          <SelectValue placeholder="Month" />
        </SelectTrigger>
        <SelectContent>
          {MONTHS.map(({ v, label }) => (
            <SelectItem key={v} value={v}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={year} onValueChange={handleYear}>
        <SelectTrigger className="w-[90px]" data-testid={`select-${testIdPrefix}-year`}>
          <SelectValue placeholder="Year" />
        </SelectTrigger>
        <SelectContent>
          {years.map(y => (
            <SelectItem key={y} value={String(y)}>
              {y}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

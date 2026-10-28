import { useState, useEffect, useRef, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar, Clock, Hand, Power, Layers, Code, ListOrdered, Terminal, ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';
import type { ScheduleOptionsProps, ScheduleType } from './types';
import { FARM_SCRIPT_DEFAULTS } from './types';
import type { FarmScriptOptions } from '../../api/client';
import {
  formatDateInput,
  formatTimeInput,
  parseDateInput,
  parseTimeInput,
  getDatePlaceholder,
  getTimePlaceholder,
  toDateTimeLocalValue,
  type DateFormat,
  type TimeFormat,
} from '../../utils/date';

/**
 * Schedule options component for queue items.
 * Includes schedule type (ASAP/Queue/Schedule), datetime picker,
 * and options for require previous success and auto power off.
 */
export function ScheduleOptionsPanel({
  options,
  onChange,
  dateFormat = 'system',
  timeFormat = 'system',
  canControlPrinter = true,
  showStagger = false,
  printerCount = 0,
  hasGcodeSnippets = false,
  hasPostProcessScript = false,
  farmCooldownTemp,
}: ScheduleOptionsProps) {
  const { t } = useTranslation();
  const [farmOptionsOpen, setFarmOptionsOpen] = useState(true);
  const farmOptions = options.scriptOptions;
  const farmDefaults = { ...FARM_SCRIPT_DEFAULTS, cooldown_temp: farmCooldownTemp ?? FARM_SCRIPT_DEFAULTS.cooldown_temp };
  const hasFarmOverrides = Object.keys(farmOptions).length > 0;
  const farmSummary = [
    `${farmOptions.cooldown_temp ?? farmDefaults.cooldown_temp}°C`,
    `F${farmOptions.push_speed ?? farmDefaults.push_speed}`,
    t('printModal.farmFlexSummary', '{{count}} flex', { count: farmOptions.flex_cycles ?? farmDefaults.flex_cycles }),
  ].join(' · ');
  // Keep overrides sparse: a value equal to its default (or cleared) is dropped
  // so the item follows the script/Settings default at dispatch time.
  const setFarmOption = (key: keyof FarmScriptOptions, value: number | undefined) => {
    const next = { ...farmOptions };
    const fallback = key === 'push_x' ? undefined : farmDefaults[key];
    if (value === undefined || value === fallback) delete next[key];
    else next[key] = value;
    onChange({ ...options, scriptOptions: next });
  };
  const [dateValue, setDateValue] = useState('');
  const [timeValue, setTimeValue] = useState('');
  const [isDateValid, setIsDateValid] = useState(true);
  const [isTimeValid, setIsTimeValid] = useState(true);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const isInitializedRef = useRef(false);

  // Initialize or sync from options.scheduledTime
  useEffect(() => {
    if (options.scheduleType !== 'scheduled') {
      isInitializedRef.current = false;
      return;
    }

    // Initialize with default time (now + 1 hour) or from existing value
    if (!isInitializedRef.current) {
      isInitializedRef.current = true;
      let date: Date;

      if (options.scheduledTime) {
        date = new Date(options.scheduledTime);
        if (isNaN(date.getTime())) {
          date = new Date();
          date.setHours(date.getHours() + 1, 0, 0, 0);
        }
      } else {
        date = new Date();
        date.setHours(date.getHours() + 1, 0, 0, 0);
        // Set initial value
        onChange({ ...options, scheduledTime: toDateTimeLocalValue(date) });
      }

      setDateValue(formatDateInput(date, dateFormat as DateFormat));
      setTimeValue(formatTimeInput(date, timeFormat as TimeFormat));
      setIsDateValid(true);
      setIsTimeValid(true);
    }
  }, [options.scheduleType, options.scheduledTime, dateFormat, timeFormat, onChange, options]);

  const handleScheduleTypeChange = (scheduleType: ScheduleType) => {
    onChange({
      ...options,
      scheduleType,
      requireManualStart: scheduleType === 'queue' ? options.requireManualStart : false,
    });
  };

  const updateScheduledTime = (newDateValue: string, newTimeValue: string) => {
    const parsedDate = parseDateInput(newDateValue, dateFormat as DateFormat);
    const parsedTime = parseTimeInput(newTimeValue);

    setIsDateValid(!!parsedDate);
    setIsTimeValid(!!parsedTime);

    if (parsedDate && parsedTime) {
      parsedDate.setHours(parsedTime.hours, parsedTime.minutes, 0, 0);
      const now = new Date();
      if (parsedDate > now) {
        onChange({ ...options, scheduledTime: toDateTimeLocalValue(parsedDate) });
      }
    }
  };

  const handleDateChange = (value: string) => {
    setDateValue(value);
    updateScheduledTime(value, timeValue);
  };

  const handleTimeChange = (value: string) => {
    setTimeValue(value);
    updateScheduledTime(dateValue, value);
  };

  // Handle calendar picker selection
  const handleCalendarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value) {
      const date = new Date(value);
      if (!isNaN(date.getTime())) {
        setDateValue(formatDateInput(date, dateFormat as DateFormat));
        setTimeValue(formatTimeInput(date, timeFormat as TimeFormat));
        setIsDateValid(true);
        setIsTimeValid(true);
        onChange({ ...options, scheduledTime: value });
      }
    }
  };

  const openCalendar = () => {
    hiddenInputRef.current?.showPicker();
  };

  return (
    <div className="space-y-4">
      {/* Schedule type */}
      <div>
        <label className="block text-sm text-bambu-gray mb-2">{t('printModal.whenToPrint')}</label>
        <div className="flex gap-2">
          <button
            type="button"
            className={`flex-1 px-2 py-2 rounded-lg border text-sm flex items-center justify-center gap-1.5 transition-colors ${
              options.scheduleType === 'asap'
                ? 'bg-bambu-green border-bambu-green text-white'
                : 'bg-bambu-dark border-bambu-dark-tertiary text-bambu-gray hover:text-white'
            }`}
            onClick={() => handleScheduleTypeChange('asap')}
          >
            <Clock className="w-4 h-4" />
            {t('printModal.asap')}
          </button>
          <button
            type="button"
            className={`flex-1 px-2 py-2 rounded-lg border text-sm flex items-center justify-center gap-1.5 transition-colors ${
              options.scheduleType === 'queue'
                ? 'bg-bambu-green border-bambu-green text-white'
                : 'bg-bambu-dark border-bambu-dark-tertiary text-bambu-gray hover:text-white'
            }`}
            onClick={() => handleScheduleTypeChange('queue')}
          >
            <ListOrdered className="w-4 h-4" />
            {t('printModal.queue')}
          </button>
          <button
            type="button"
            className={`flex-1 px-2 py-2 rounded-lg border text-sm flex items-center justify-center gap-1.5 transition-colors ${
              options.scheduleType === 'scheduled'
                ? 'bg-bambu-green border-bambu-green text-white'
                : 'bg-bambu-dark border-bambu-dark-tertiary text-bambu-gray hover:text-white'
            }`}
            onClick={() => handleScheduleTypeChange('scheduled')}
          >
            <Calendar className="w-4 h-4" />
            {t('printModal.schedule')}
          </button>
        </div>
      </div>

      {/* Scheduled time input */}
      {options.scheduleType === 'scheduled' && (
        <div>
          <label className="block text-sm text-bambu-gray mb-1">{t('printModal.dateTime')}</label>
          <div className="flex gap-2">
            {/* Date input */}
            <div className="flex-1 relative">
              <input
                type="text"
                className={`w-full px-3 py-2 pr-10 bg-bambu-dark border rounded-lg text-white focus:outline-none ${
                  isDateValid
                    ? 'border-bambu-dark-tertiary focus:border-bambu-green'
                    : 'border-red-500'
                }`}
                value={dateValue}
                onChange={(e) => handleDateChange(e.target.value)}
                placeholder={getDatePlaceholder(dateFormat as DateFormat)}
              />
              <button
                type="button"
                onClick={openCalendar}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-bambu-gray hover:text-white"
                title={t('printModal.openCalendar')}
              >
                <Calendar className="w-4 h-4" />
              </button>
              {/* Hidden datetime-local anchored here so the native picker opens near the date field */}
              <input
                ref={hiddenInputRef}
                type="datetime-local"
                className="absolute top-0 left-0 w-0 h-0 opacity-0 pointer-events-none"
                value={options.scheduledTime}
                onChange={handleCalendarChange}
                tabIndex={-1}
              />
            </div>
            {/* Time input */}
            <div className="w-32">
              <input
                type="text"
                className={`w-full px-3 py-2 bg-bambu-dark border rounded-lg text-white focus:outline-none ${
                  isTimeValid
                    ? 'border-bambu-dark-tertiary focus:border-bambu-green'
                    : 'border-red-500'
                }`}
                value={timeValue}
                onChange={(e) => handleTimeChange(e.target.value)}
                placeholder={getTimePlaceholder(timeFormat as TimeFormat)}
              />
            </div>
          </div>
          {(!isDateValid || !isTimeValid) && (
            <p className="mt-1 text-xs text-red-700 dark:text-red-400">
              {t('printModal.invalidDateTime')}
            </p>
          )}
        </div>
      )}

      {/* Manual start */}
      {options.scheduleType === 'queue' && (
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="requireManualStart"
            checked={options.requireManualStart}
            onChange={(e) => onChange({ ...options, requireManualStart: e.target.checked })}
            className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
          />
          <label htmlFor="requireManualStart" className="text-sm flex items-center gap-1 text-bambu-gray">
            <Hand className="w-3.5 h-3.5" />
            {t('printModal.requireManualStart')}
          </label>
        </div>
      )}

      {/* Require previous success */}
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="requirePrevious"
          checked={options.requirePreviousSuccess}
          onChange={(e) => onChange({ ...options, requirePreviousSuccess: e.target.checked })}
          className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
        />
        <label htmlFor="requirePrevious" className="text-sm text-bambu-gray">
          {t('printModal.requirePreviousSuccess')}
        </label>
      </div>

      {/* Auto power off */}
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="autoOffAfter"
          checked={options.autoOffAfter}
          onChange={(e) => onChange({ ...options, autoOffAfter: e.target.checked })}
          disabled={!canControlPrinter}
          className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green disabled:opacity-50"
        />
        <label htmlFor="autoOffAfter" className={`text-sm flex items-center gap-1 ${canControlPrinter ? 'text-bambu-gray' : 'text-bambu-gray/50'}`}>
          <Power className="w-3.5 h-3.5" />
          {t('printModal.autoOffAfter')}
        </label>
      </div>

      {/* G-code injection */}
      {hasGcodeSnippets && (
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="gcodeInjection"
            checked={options.gcodeInjection}
            onChange={(e) => onChange({ ...options, gcodeInjection: e.target.checked })}
            className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
          />
          <label htmlFor="gcodeInjection" className="text-sm flex items-center gap-1 text-bambu-gray">
            <Code className="w-3.5 h-3.5" />
            {t('printModal.gcodeInjection', 'Inject auto-print G-code')}
          </label>
        </div>
      )}

      {/* Farm post-process script */}
      {hasPostProcessScript && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="scriptProcessing"
              checked={options.scriptProcessing}
              onChange={(e) => onChange({ ...options, scriptProcessing: e.target.checked })}
              className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
            />
            <label htmlFor="scriptProcessing" className="text-sm flex items-center gap-1 text-bambu-gray">
              <Terminal className="w-3.5 h-3.5" />
              {t('printModal.scriptProcessing', 'Run farm post-processor')}
            </label>
            {options.scriptProcessing && (
              <button
                type="button"
                onClick={() => setFarmOptionsOpen(!farmOptionsOpen)}
                className="ml-auto flex items-center gap-1 text-xs text-bambu-gray hover:text-white"
                title={t('printModal.farmOptionsCustomize', 'Customize farm post-processor options')}
              >
                {hasFarmOverrides && <span className="w-1.5 h-1.5 rounded-full bg-bambu-green" />}
                {farmSummary}
                {farmOptionsOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
            )}
          </div>

          {options.scriptProcessing && farmOptionsOpen && (
            <div className="ml-6 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <FarmNumberField
                  label={t('printModal.farmCooldownTemp', 'Cooldown temp (°C)')}
                  value={farmOptions.cooldown_temp}
                  defaultValue={farmDefaults.cooldown_temp}
                  min={20}
                  max={80}
                  onCommit={(v) => setFarmOption('cooldown_temp', v)}
                />
                <FarmNumberField
                  label={t('printModal.farmPushSpeed', 'Push speed (mm/min)')}
                  value={farmOptions.push_speed}
                  defaultValue={farmDefaults.push_speed}
                  min={300}
                  max={6000}
                  onCommit={(v) => setFarmOption('push_speed', v)}
                />
                <FarmNumberField
                  label={t('printModal.farmPushX', 'Push X centre (mm)')}
                  value={farmOptions.push_x}
                  defaultValue={undefined}
                  placeholder={t('printModal.farmAuto', 'Auto')}
                  min={10}
                  max={246}
                  step={0.1}
                  onCommit={(v) => setFarmOption('push_x', v)}
                />
                <FarmNumberField
                  label={t('printModal.farmLaneOffset', 'Lane offset (mm)')}
                  value={farmOptions.lane_offset}
                  defaultValue={farmDefaults.lane_offset}
                  min={0}
                  max={120}
                  step={0.1}
                  onCommit={(v) => setFarmOption('lane_offset', v)}
                />
                <FarmNumberField
                  label={t('printModal.farmFlexCycles', 'Bed flex cycles')}
                  value={farmOptions.flex_cycles}
                  defaultValue={farmDefaults.flex_cycles}
                  min={0}
                  max={10}
                  onCommit={(v) => setFarmOption('flex_cycles', v)}
                />
                <FarmNumberField
                  label={t('printModal.farmFlexSpeed', 'Flex speed (mm/min)')}
                  value={farmOptions.flex_speed}
                  defaultValue={farmDefaults.flex_speed}
                  min={60}
                  max={1200}
                  onCommit={(v) => setFarmOption('flex_speed', v)}
                />
                {/* Clip engages at Z204, bed bottoms out at Z256; the script caps the
                    flex bottom at Z250, so 46mm is the deepest drop it will honour. */}
                <FarmNumberField
                  label={t('printModal.farmFlexDrop', 'Bed drop (mm)')}
                  value={farmOptions.flex_drop}
                  defaultValue={farmDefaults.flex_drop}
                  min={1}
                  max={46}
                  step={0.1}
                  onCommit={(v) => setFarmOption('flex_drop', v)}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-bambu-gray">
                  {t('printModal.farmOptionsHelp', 'Applies to this print only. Cooldown default comes from Settings → Workflow.')}
                </p>
                {hasFarmOverrides && (
                  <button
                    type="button"
                    onClick={() => onChange({ ...options, scriptOptions: {} })}
                    className="flex items-center gap-1 text-xs text-bambu-gray hover:text-white whitespace-nowrap"
                  >
                    <RotateCcw className="w-3 h-3" />
                    {t('printModal.farmOptionsReset', 'Reset to defaults')}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Stagger start */}
      {showStagger && options.scheduleType !== 'queue' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="staggerEnabled"
              checked={options.staggerEnabled}
              onChange={(e) => onChange({ ...options, staggerEnabled: e.target.checked })}
              className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
            />
            <label htmlFor="staggerEnabled" className="text-sm flex items-center gap-1 text-bambu-gray">
              <Layers className="w-3.5 h-3.5" />
              {t('printModal.staggerPrinterStarts', 'Stagger printer starts')}
            </label>
          </div>

          {options.staggerEnabled && (
            <div className="ml-6 space-y-3">
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs text-bambu-gray mb-1">{t('printModal.staggerGroupSize', 'Group size')}</label>
                  <input
                    type="number"
                    min={1}
                    max={printerCount}
                    value={options.staggerGroupSize}
                    onChange={(e) => onChange({ ...options, staggerGroupSize: Math.max(1, parseInt(e.target.value) || 1) })}
                    className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:border-bambu-green"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-bambu-gray mb-1">{t('printModal.staggerInterval', 'Interval (min)')}</label>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={options.staggerIntervalMinutes}
                    onChange={(e) => onChange({ ...options, staggerIntervalMinutes: Math.max(1, parseInt(e.target.value) || 1) })}
                    className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:border-bambu-green"
                  />
                </div>
              </div>
              {printerCount > 0 && (() => {
                const groupCount = Math.ceil(printerCount / options.staggerGroupSize);
                const lastGroupSize = printerCount % options.staggerGroupSize;
                const totalMinutes = (groupCount - 1) * options.staggerIntervalMinutes;
                return (
                  <p className="text-xs text-bambu-gray">
                    {t('printModal.staggerPreview', '{{printers}} printers → {{groups}} groups of {{size}}, starting every {{interval}} min', {
                      printers: printerCount,
                      groups: groupCount,
                      size: options.staggerGroupSize,
                      interval: options.staggerIntervalMinutes,
                    })}
                    {lastGroupSize !== 0 && options.staggerGroupSize < printerCount
                      ? ` (${t('printModal.staggerLastGroup', 'last group: {{count}}', { count: lastGroupSize })})`
                      : ''}
                    {groupCount > 1
                      ? ` (${t('printModal.staggerTotal', 'total: {{minutes}} min', { minutes: totalMinutes })})`
                      : ''}
                  </p>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* Help text */}
      <p className="text-xs text-bambu-gray">
        {options.scheduleType === 'asap'
          ? t('printModal.helpAsap')
          : options.scheduleType === 'scheduled'
          ? t('printModal.helpSchedule')
          : t('printModal.helpQueue')}
      </p>
    </div>
  );
}

/**
 * Number input for a farm post-processor option. Shows the effective value
 * (override, else default) and keeps free-form text while typing; commits on
 * every valid in-range edit and clamps on blur. Clearing the field reverts to
 * the default.
 */
function FarmNumberField({
  label,
  value,
  defaultValue,
  placeholder,
  min,
  max,
  step = 1,
  onCommit,
}: {
  label: string;
  value: number | undefined;
  defaultValue: number | undefined;
  placeholder?: string;
  min: number;
  max: number;
  step?: number;
  onCommit: (value: number | undefined) => void;
}) {
  const id = useId();
  const effective = value ?? defaultValue;
  const [text, setText] = useState(effective === undefined ? '' : String(effective));

  // Re-sync when the value changes from outside (reset, settings load, edit mode).
  useEffect(() => {
    setText(effective === undefined ? '' : String(effective));
  }, [effective]);

  const parse = (raw: string) => (step < 1 ? parseFloat(raw) : parseInt(raw, 10));

  return (
    <div>
      <label htmlFor={id} className="block text-xs text-bambu-gray mb-1">{label}</label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        placeholder={placeholder ?? (defaultValue !== undefined ? String(defaultValue) : undefined)}
        onChange={(e) => {
          setText(e.target.value);
          const n = parse(e.target.value);
          if (!isNaN(n) && n >= min && n <= max) onCommit(n);
        }}
        onBlur={() => {
          if (text.trim() === '') {
            onCommit(undefined);
            setText(defaultValue === undefined ? '' : String(defaultValue));
            return;
          }
          const n = parse(text);
          const clamped = isNaN(n) ? defaultValue : Math.min(max, Math.max(min, n));
          onCommit(clamped);
          setText(clamped === undefined ? '' : String(clamped));
        }}
        className={`w-full px-3 py-2 bg-bambu-dark border rounded-lg text-white text-sm focus:outline-none focus:border-bambu-green ${
          value !== undefined ? 'border-bambu-green/60' : 'border-bambu-dark-tertiary'
        }`}
      />
    </div>
  );
}

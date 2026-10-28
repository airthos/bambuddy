/**
 * Tests for the farm post-processor options under the "Run farm post-processor"
 * checkbox in the Print modal's schedule options.
 */

import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '../utils';
import { ScheduleOptionsPanel } from '../../components/PrintModal/ScheduleOptions';
import { DEFAULT_SCHEDULE_OPTIONS, type ScheduleOptions } from '../../components/PrintModal/types';

function Harness({ onChange, initial = DEFAULT_SCHEDULE_OPTIONS }: {
  onChange: (o: ScheduleOptions) => void;
  initial?: ScheduleOptions;
}) {
  const [options, setOptions] = useState(initial);
  return (
    <ScheduleOptionsPanel
      options={options}
      onChange={(o) => { setOptions(o); onChange(o); }}
      hasPostProcessScript
      farmCooldownTemp={38}
    />
  );
}

describe('ScheduleOptionsPanel farm post-processor options', () => {
  it('opens expanded with defaults (cooldown from settings) and collapses on click', () => {
    render(<Harness onChange={vi.fn()} />);
    expect((screen.getByLabelText('Cooldown temp (°C)') as HTMLInputElement).value).toBe('38');
    expect((screen.getByLabelText('Bed drop (mm)') as HTMLInputElement).value).toBe('20');
    fireEvent.click(screen.getByText('38°C · F2000 · 3 flex'));
    expect(screen.queryByText('Cooldown temp (°C)')).not.toBeInTheDocument();
  });

  it('caps bed drop at the safe maximum on blur', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const drop = screen.getByLabelText('Bed drop (mm)') as HTMLInputElement;
    fireEvent.change(drop, { target: { value: '60' } });
    fireEvent.blur(drop);
    expect(drop.value).toBe('46');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ scriptOptions: { flex_drop: 46 } }));
  });

  it('records only the overridden fields and drops values equal to the default', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const cooldown = screen.getByLabelText('Cooldown temp (°C)') as HTMLInputElement;
    expect(cooldown.value).toBe('38');

    fireEvent.change(cooldown, { target: { value: '30' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ scriptOptions: { cooldown_temp: 30 } }));

    fireEvent.change(cooldown, { target: { value: '38' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ scriptOptions: {} }));
  });

  it('clamps out-of-range values on blur', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const flex = screen.getByLabelText('Bed flex cycles') as HTMLInputElement;
    fireEvent.change(flex, { target: { value: '99' } });
    fireEvent.blur(flex);
    expect(flex.value).toBe('10');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ scriptOptions: { flex_cycles: 10 } }));
  });

  it('reset clears all overrides', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} initial={{ ...DEFAULT_SCHEDULE_OPTIONS, scriptOptions: { push_speed: 1500 } }} />);
    fireEvent.click(screen.getByText('Reset to defaults'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ scriptOptions: {} }));
  });

  it('hides the options when the post-processor is unchecked', () => {
    render(<Harness onChange={vi.fn()} initial={{ ...DEFAULT_SCHEDULE_OPTIONS, scriptProcessing: false }} />);
    expect(screen.queryByText(/flex$/)).not.toBeInTheDocument();
  });
});

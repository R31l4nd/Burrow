import { errorMessage } from './api.js';
import { toast } from './ui.svelte.js';

// A dialog form's Save (an alert rule, a report schedule, a snippet, a key):
// one save at a time, so pressing Save twice while the first is on its way
// makes one, not two (AUDIT2 PAGE-11). What follows a save (the dialog
// closed, the form emptied) belongs to the form it was pressed in: closed
// and another one opened meanwhile, that other one stays as it is (PAGE-12).
export class FormSave {
  busy = $state(false);
  #form = 0;

  /** The form was opened (again, or for another item): saves still on their way are no longer its. */
  opened(): void {
    this.#form += 1;
  }

  /**
   * Runs save unless one is on its way. 'saved': done, and the form is still the
   * one it was pressed in; 'elsewhere': done, but another form is open now;
   * null: not run (busy) or failed (said in a toast).
   */
  async run(save: () => Promise<unknown>): Promise<'saved' | 'elsewhere' | null> {
    if (this.busy) return null;
    this.busy = true;
    const form = this.#form;
    try {
      await save();
      return form === this.#form ? 'saved' : 'elsewhere';
    } catch (err) {
      toast(errorMessage(err), 'error');
      return null;
    } finally {
      this.busy = false;
    }
  }
}

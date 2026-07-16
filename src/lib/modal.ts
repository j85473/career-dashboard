export type ModalType = 'alert' | 'confirm' | 'options';

export interface ModalOption {
  label: string;
  value: string;
  primary?: boolean;
}

export type ModalHandler = (
  message: string,
  type: ModalType,
  options: ModalOption[],
  resolve: (value: string | null) => void
) => void;

let handler: ModalHandler | null = null;

export function setModalHandler(h: ModalHandler) {
  handler = h;
}

export function showAlert(message: string, buttonText = 'OK'): Promise<void> {
  if (!handler) {
    window.alert(message);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    handler!(message, 'alert', [{ label: buttonText, value: 'ok', primary: true }], () => resolve());
  });
}

export function showConfirm(message: string, confirmText = 'OK', cancelText = 'Cancel'): Promise<boolean> {
  if (!handler) {
    return Promise.resolve(window.confirm(message));
  }
  return new Promise((resolve) => {
    handler!(
      message,
      'confirm',
      [
        { label: cancelText, value: 'cancel' },
        { label: confirmText, value: 'confirm', primary: true }
      ],
      (val) => resolve(val === 'confirm')
    );
  });
}

export function showOptions(message: string, options: ModalOption[]): Promise<string | null> {
  if (!handler) {
    const fallback = window.prompt(`${message}\n\nOptions:\n${options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}\n\nEnter number:`);
    if (fallback) {
      const idx = parseInt(fallback) - 1;
      if (idx >= 0 && idx < options.length) return Promise.resolve(options[idx].value);
    }
    return Promise.resolve(null);
  }
  
  return new Promise((resolve) => {
    const optionsWithCancel = [...options, { label: 'Cancel', value: 'cancel' }];
    handler!(message, 'options', optionsWithCancel, (val) => resolve(val === 'cancel' ? null : val));
  });
}

import { Modal, View } from 'react-native';
import { radius, spacing } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';
import { AppText } from './AppText';
import { Banner } from './Banner';
import { Button } from './Button';

interface Props {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Disables both buttons and shows a spinner on Confirm while the action runs. */
  busy?: boolean;
  /** Shown inside the dialog if the action failed in a way the person can retry. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A confirmation box that works on phones and in the browser (the phone-only Alert does nothing on the web).
 * Cancel (or the back button / Escape key) closes it without doing anything.
 */
export function ConfirmDialog({ visible, title, message, confirmLabel, cancelLabel = 'Cancel', busy = false, error = null, onConfirm, onCancel }: Props) {
  const { colors } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={busy ? () => {} : onCancel}>
      {/* The dimmed backdrop is the one colour that is not a theme token: it must darken whatever is behind it in both themes. */}
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg }}>
        <View
          testID="confirm-dialog"
          role="alertdialog"
          aria-modal
          aria-label={title}
          style={{
            width: '100%',
            maxWidth: 420,
            gap: spacing.md,
            padding: spacing.lg,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface,
          }}
        >
          <AppText variant="heading" testID="confirm-title">
            {title}
          </AppText>
          <AppText testID="confirm-message">{message}</AppText>
          {error && (
            <Banner kind="error" testID="confirm-error">
              {error}
            </Banner>
          )}
          <View style={{ gap: spacing.sm }}>
            <Button testID="confirm-confirm" label={confirmLabel} onPress={onConfirm} loading={busy} />
            <Button testID="confirm-cancel" label={cancelLabel} variant="secondary" onPress={onCancel} disabled={busy} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

import { useState, type ReactNode } from 'react';
import { Pressable, Text, TextInput, View, type TextInputProps } from 'react-native';
import { fontFamily } from '../theme/fonts';
import { fontSize, radius, spacing } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';
import { AppText } from './AppText';
import { useSurface } from './Surface';
import { reportFieldBlur, reportFieldFocus } from '../lib/keyboardNav';

interface Props
  extends Pick<
    TextInputProps,
    | 'value'
    | 'onChangeText'
    | 'keyboardType'
    | 'autoCapitalize'
    | 'autoComplete'
    | 'textContentType'
    | 'returnKeyType'
    | 'onSubmitEditing'
    | 'editable'
    | 'maxLength'
    | 'multiline'
    | 'selection'
    | 'onSelectionChange'
    | 'inputMode'
  > {
  label: string;
  /** Optional button or icon shown inside the field, after the text (for example a calendar button). */
  trailing?: ReactNode;
  error?: string | undefined;
  helper?: string | undefined;
  placeholder?: string | undefined;
  /** Password field: hides the text and adds a Show/Hide button. */
  secret?: boolean;
  testID?: string;
}

export function TextField({ label, error, helper, placeholder, secret = false, testID, trailing, ...input }: Props) {
  const { colors } = useTheme();
  const [revealed, setRevealed] = useState(false);
  const [focused, setFocused] = useState(false);
  const onSurface = useSurface() === 'surface';

  return (
    <View style={{ gap: spacing.xs }}>
      <AppText variant="small" tone="secondary" style={{ fontWeight: '600' }}>
        {label}
      </AppText>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          minHeight: 48,
          borderRadius: radius.md,
          // Flat tonal field: no outline, except a clear error ring (an error must not rely on text alone).
          borderWidth: error || focused ? 2 : 0,
          borderColor: error ? colors.statusError : colors.primaryText,
          backgroundColor: onSurface ? colors.surface2 : colors.surface,
        }}
      >
        <TextInput
          {...input}
          testID={testID}
          accessibilityLabel={label}
          placeholder={placeholder}
          placeholderTextColor={onSurface ? colors.textSecondaryOnSurface : colors.textSecondary}
          secureTextEntry={secret && !revealed}
          autoCorrect={false}
          onFocus={() => {
            setFocused(true);
            reportFieldFocus();
          }}
          onBlur={() => {
            setFocused(false);
            reportFieldBlur();
          }}
          style={{
            flex: 1,
            minHeight: input.multiline ? 96 : 46,
            paddingHorizontal: spacing.md,
            paddingVertical: input.multiline ? spacing.sm : 0,
            textAlignVertical: input.multiline ? 'top' : 'center',
            color: colors.textPrimary,
            fontSize: fontSize.body,
            fontFamily: fontFamily.body,
            // the focus ring is drawn on the field around the input, so the browser's own outline is switched off
            ...({ outlineStyle: 'none' } as object),
          }}
        />
        {trailing}
        {secret && (
          <Pressable
            onPress={() => setRevealed((v) => !v)}
            role="button"
            aria-label={revealed ? 'Hide password' : 'Show password'}
            hitSlop={8}
            style={{ paddingHorizontal: spacing.md, minHeight: 46, justifyContent: 'center' }}
          >
            <Text style={{ color: colors.primaryText, fontWeight: '600', fontSize: fontSize.small }}>{revealed ? 'Hide' : 'Show'}</Text>
          </Pressable>
        )}
      </View>
      {error ? (
        <AppText variant="small" tone="error" aria-live="polite">
          {error}
        </AppText>
      ) : helper ? (
        <AppText variant="small" tone="secondary">
          {helper}
        </AppText>
      ) : null}
    </View>
  );
}

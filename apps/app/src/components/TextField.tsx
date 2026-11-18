import { useState, type ReactNode } from 'react';
import { Pressable, Text, TextInput, View, type TextInputProps } from 'react-native';
import { fontSize, radius, spacing } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';
import { AppText } from './AppText';

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
          borderWidth: 1,
          borderColor: error ? colors.statusError : colors.border,
          backgroundColor: colors.surface,
        }}
      >
        <TextInput
          {...input}
          testID={testID}
          accessibilityLabel={label}
          placeholder={placeholder}
          placeholderTextColor={colors.textSecondary}
          secureTextEntry={secret && !revealed}
          autoCorrect={false}
          style={{
            flex: 1,
            minHeight: input.multiline ? 96 : 46,
            paddingHorizontal: spacing.md,
            paddingVertical: input.multiline ? spacing.sm : 0,
            textAlignVertical: input.multiline ? 'top' : 'center',
            color: colors.textPrimary,
            fontSize: fontSize.body,
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
            <Text style={{ color: colors.primary, fontWeight: '600', fontSize: fontSize.small }}>{revealed ? 'Hide' : 'Show'}</Text>
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

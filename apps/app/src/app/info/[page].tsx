import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText } from '../../components/AppText';
import { Card } from '../../components/Card';
import { SiteFooter, SiteTopBar } from '../../features/site/SiteParts';
import { INFO_PAGES, PLACEHOLDER_NOTICE, isInfoPage } from '../../features/site/siteContent';
import { useTheme } from '../../theme/ThemeProvider';
import { spacing } from '../../theme/tokens';

/**
 * Company and legal pages (About, Contact, Privacy Policy, Terms and Conditions, Help). They are PLACEHOLDERS: they carry
 * no policy text, no contact details and no commitments, and say so on the page. Open to everyone, signed in or not.
 */
export default function InfoScreen() {
  const params = useLocalSearchParams<{ page?: string | string[] }>();
  const raw = (Array.isArray(params.page) ? params.page[0] : params.page) ?? '';
  const { colors } = useTheme();
  const router = useRouter();
  const page = isInfoPage(raw) ? INFO_PAGES[raw] : null;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
        <SiteTopBar />
        <View style={{ flexGrow: 1, padding: spacing.lg, paddingBottom: spacing.xl * 2 }}>
          <View style={{ width: '100%', maxWidth: 720, alignSelf: 'center', gap: spacing.lg }}>
            <AppText variant="title" testID="info-title" role="heading" aria-level={1}>
              {page ? page.title : 'Page not found'}
            </AppText>
            {page?.intro && <AppText tone="secondary">{page.intro}</AppText>}
            {page && (
              <Card>
                <AppText variant="eyebrow" tone="accent">
                  Placeholder
                </AppText>
                <AppText testID="info-placeholder">{PLACEHOLDER_NOTICE}</AppText>
              </Card>
            )}
            {!page && <AppText tone="secondary">That page does not exist.</AppText>}
          </View>
        </View>
        <SiteFooter onFeatures={() => router.push('/welcome')} onHow={() => router.push('/welcome')} />
      </ScrollView>
    </SafeAreaView>
  );
}

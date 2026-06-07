-- Execute este arquivo no SQL Editor do Supabase se aparecer erro de permissão.
GRANT SELECT, INSERT, UPDATE ON public.participantes TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.pagamentos TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.apostas TO service_role;

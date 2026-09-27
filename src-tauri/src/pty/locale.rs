//! A UTF-8 locale for a shell that would otherwise start without one.
//!
//! An app opened from the Finder inherits launchd's environment, and launchd
//! sets no `LANG` and no `LC_*` — `launchctl getenv LANG` is empty. A shell
//! started from there runs in the C locale. zsh copes; bash's readline does
//! not: in C it takes every byte above 0x7f for a Meta key (`convert-meta`),
//! so Hangul typed at the prompt, or brought back from history, runs key
//! bindings instead of appearing. Terminal.app and VS Code
//! (`terminal.integrated.detectLocale`) both give a shell a UTF-8 `LANG` when
//! it inherits none, and so does this.
//!
//! Three rules keep that from doing harm:
//!
//! - Only when `LC_ALL`, `LC_CTYPE` and `LANG` — the variables that decide
//!   the character set — are all unset or empty. A locale the user chose is
//!   left exactly as it is: `LANG=C` is a choice, and so is a name this
//!   machine cannot load.
//! - Only `LANG`, the weakest of the three, so whatever the user's own rc
//!   files set still wins.
//! - Only a locale this machine can load. A `LANG` naming one it cannot is no
//!   better than none — `setlocale` fails and the shell stays in C — and the
//!   region setting on the Mac this was found on names exactly that: `en_KR`,
//!   for which macOS has no `en_KR.UTF-8`. Every candidate goes through
//!   `newlocale`, the C-library lookup the shell's own `setlocale` makes.
//!
//! On macOS the locale follows the user's region setting, then their
//! language's main locale, then `en_US.UTF-8`. Elsewhere it is `C.UTF-8`, or
//! `en_US.UTF-8` where that is missing: a Linux session hands its locale down
//! through the environment, so a shell that inherits none has nothing better
//! to go on. Windows shells read none of these, and this module is not built
//! there.
//!
//! The decision is `lang_to_set`, a pure function of the environment, the
//! region setting and a probe for what exists, so the tests can pin every
//! case. `lang_for` gathers those inputs, and works the machine's half out
//! only once: it is the same for every shell the app starts.

use std::ffi::{CString, OsString};
use std::sync::OnceLock;

/// The variables that decide `LC_CTYPE`, strongest first. No other `LC_*`
/// variable says anything about the character set.
const DECIDING: [&str; 3] = ["LC_ALL", "LC_CTYPE", "LANG"];

/// Where a default locale is derived from.
#[derive(Clone, Copy, Debug)]
enum System<'a> {
    /// macOS, with the user's region setting (`AppleLocale`) when there is
    /// one: an ICU locale ID such as `en_KR`, `ko_KR` or `zh-Hant_TW`.
    Mac(Option<&'a str>),
    /// Linux and the other unixes.
    Other,
}

/// The region each language's UTF-8 locale is filed under on macOS: the only
/// one when there is one (`ko_KR`), the language's main one when there are
/// several (`de_DE`, not `de_AT` or `de_CH`) — the region CLDR considers most
/// likely for the language.
///
/// Every language with a `*.UTF-8` locale in /usr/share/locale is here, which
/// a test checks against the machine rather than trusting this list. A
/// language that is not here has no UTF-8 locale on macOS at all.
const MAIN_REGION: &[(&str, &str)] = &[
    ("af", "ZA"), ("am", "ET"), ("ar", "EG"), ("be", "BY"), ("bg", "BG"), ("ca", "ES"),
    ("cs", "CZ"), ("da", "DK"), ("de", "DE"), ("el", "GR"), ("en", "US"), ("es", "ES"),
    ("et", "EE"), ("eu", "ES"), ("fa", "IR"), ("fi", "FI"), ("fr", "FR"), ("ga", "IE"),
    ("he", "IL"), ("hi", "IN"), ("hr", "HR"), ("hu", "HU"), ("hy", "AM"), ("is", "IS"),
    ("it", "IT"), ("ja", "JP"), ("kk", "KZ"), ("ko", "KR"), ("lt", "LT"), ("lv", "LV"),
    ("mn", "MN"), ("nb", "NO"), ("nl", "NL"), ("nn", "NO"), ("no", "NO"), ("pl", "PL"),
    ("pt", "BR"), ("ro", "RO"), ("ru", "RU"), ("se", "NO"), ("sk", "SK"), ("sl", "SI"),
    ("sr", "RS"), ("sv", "SE"), ("tr", "TR"), ("uk", "UA"), ("zh", "CN"),
];

/// The `LANG` to give a shell whose environment is `inherited`, or `None` to
/// leave that environment exactly as it is.
pub(crate) fn lang_for(inherited: impl Fn(&str) -> Option<OsString>) -> Option<&'static str> {
    if names_a_locale(inherited) {
        return None;
    }
    // What a shell that inherits no locale gets depends only on the machine,
    // so it is worked out on the first spawn and kept.
    static MACHINE_DEFAULT: OnceLock<Option<String>> = OnceLock::new();
    MACHINE_DEFAULT
        .get_or_init(|| {
            let apple_locale = apple_locale();
            let system = if cfg!(target_os = "macos") {
                System::Mac(apple_locale.as_deref())
            } else {
                System::Other
            };
            lang_to_set(|_| None, system, locale_exists)
        })
        .as_deref()
}

/// The decision, with everything it depends on passed in: the `LANG` to
/// set, or `None` to leave the environment alone.
///
/// `inherited` looks a variable up in the environment the shell would start
/// with, and `exists` says whether this machine can load a locale.
fn lang_to_set(
    inherited: impl Fn(&str) -> Option<OsString>,
    system: System<'_>,
    exists: impl Fn(&str) -> bool,
) -> Option<String> {
    if names_a_locale(inherited) {
        return None;
    }
    candidates(system).into_iter().find(|name| exists(name))
}

/// Whether the environment a shell would start with already says which
/// character set to use.
fn names_a_locale(inherited: impl Fn(&str) -> Option<OsString>) -> bool {
    // Set to anything, `C` included, is somebody's choice. Empty is not: the
    // C library passes over an empty variable as if it were not there.
    DECIDING
        .iter()
        .any(|name| inherited(name).is_some_and(|value| !value.is_empty()))
}

/// The locales to try, best first.
fn candidates(system: System<'_>) -> Vec<String> {
    let mut names = Vec::new();
    match system {
        System::Mac(apple_locale) => {
            if let Some(id) = apple_locale.and_then(LocaleId::parse) {
                if let Some(region) = &id.region {
                    names.push(format!("{}_{region}.UTF-8", id.language));
                }
                if let Some(region) = id.main_region() {
                    names.push(format!("{}_{region}.UTF-8", id.language));
                }
            }
            names.push("en_US.UTF-8".to_string());
        }
        System::Other => {
            names.push("C.UTF-8".to_string());
            names.push("en_US.UTF-8".to_string());
        }
    }
    names.dedup();
    names
}

/// The parts of an ICU locale ID that a POSIX locale name is built from.
struct LocaleId<'a> {
    /// Lower case, as a POSIX name spells it.
    language: String,
    script: Option<&'a str>,
    /// Upper case, as a POSIX name spells it.
    region: Option<String>,
}

impl<'a> LocaleId<'a> {
    /// `en_KR`, `zh-Hant_TW`, `es_419`, `en_US@rg=krzzzz`.
    ///
    /// Keywords after the `@` have no POSIX spelling and are dropped, and the
    /// first part that is not a language, script or region ends the parse. An
    /// ID that does not begin with a language is not used at all. That is
    /// what keeps anything but a plain locale name away from `newlocale`, to
    /// which an empty name means "whatever the environment says" and a slash
    /// makes a path.
    fn parse(id: &'a str) -> Option<Self> {
        let base = id.split('@').next().unwrap_or_default();
        let mut subtags = base.split(['-', '_']);
        let language = subtags
            .next()
            .filter(|l| (2..=3).contains(&l.len()) && l.bytes().all(|b| b.is_ascii_alphabetic()))?;
        let mut script = None;
        let mut region = None;
        for subtag in subtags {
            let letters = subtag.bytes().all(|b| b.is_ascii_alphabetic());
            let digits = subtag.bytes().all(|b| b.is_ascii_digit());
            if script.is_none() && region.is_none() && subtag.len() == 4 && letters {
                script = Some(subtag);
            } else if region.is_none()
                && ((subtag.len() == 2 && letters) || (subtag.len() == 3 && digits))
            {
                region = Some(subtag.to_ascii_uppercase());
            } else {
                break;
            }
        }
        Some(LocaleId { language: language.to_ascii_lowercase(), script, region })
    }

    /// The region of the language's main locale on macOS.
    fn main_region(&self) -> Option<&'static str> {
        // Chinese is filed by script as much as by region: the table's zh_CN
        // is Simplified, and Traditional is Taiwan's.
        if self.language == "zh" && self.script.is_some_and(|s| s.eq_ignore_ascii_case("hant")) {
            return Some("TW");
        }
        MAIN_REGION
            .iter()
            .find(|(language, _)| *language == self.language)
            .map(|(_, region)| *region)
    }
}

/// Whether the C library can load `name` for every category, which is what
/// the shell's `setlocale(LC_ALL, "")` will need of it.
///
/// Every category, not just the character set: macOS's bare `UTF-8` has an
/// `LC_CTYPE` and nothing else, and as a `LANG` it makes that `setlocale`
/// fail outright.
fn locale_exists(name: &str) -> bool {
    // An empty name asks for whatever THIS process's environment names,
    // which is not the question.
    if name.is_empty() {
        return false;
    }
    let Ok(name) = CString::new(name) else {
        return false;
    };
    // Spelled out, because the libc crate has LC_ALL_MASK for glibc and
    // macOS but not for musl.
    let every_category = libc::LC_CTYPE_MASK
        | libc::LC_COLLATE_MASK
        | libc::LC_MESSAGES_MASK
        | libc::LC_MONETARY_MASK
        | libc::LC_NUMERIC_MASK
        | libc::LC_TIME_MASK;
    // SAFETY: `newlocale` reads a NUL-terminated name that outlives the call
    // and, given no base locale, returns a new locale object or NULL. One it
    // returns belongs to us alone and is freed at once.
    unsafe {
        let locale = libc::newlocale(every_category, name.as_ptr(), std::ptr::null_mut());
        if locale.is_null() {
            return false;
        }
        libc::freelocale(locale);
    }
    true
}

/// The user's region setting on macOS, as `defaults read -g AppleLocale`
/// prints it; `None` when it is not set, and on every other system.
///
/// Read from CFPreferences, where `defaults` reads it, rather than by
/// running `defaults`. Every process this backend starts must be told not to
/// open a console window on Windows, and the test in fs/git.rs that holds it
/// to that reads the source. A macOS-only spawn has no Windows flag it could
/// meaningfully carry, so it would pass only with a flag that can never be
/// compiled in, or by teaching the scan to excuse some spawns — and either
/// is where the next real one would hide. Not spawning also keeps a fork and
/// an exec out of the first terminal's way.
fn apple_locale() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        core_foundation::apple_locale()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Just enough CoreFoundation to read one preference. Every macOS app links
/// the framework already, so this adds nothing to the binary's dependencies.
#[cfg(target_os = "macos")]
mod core_foundation {
    use std::ffi::{c_char, c_long, c_ulong, c_void, CStr};

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFIndex = c_long;
    type CFTypeID = c_ulong;
    type CFStringEncoding = u32;
    type Boolean = u8;

    /// `kCFStringEncodingUTF8`.
    const UTF8: CFStringEncoding = 0x0800_0100;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFPreferencesAnyApplication: CFStringRef;
        fn CFStringCreateWithCString(
            alloc: CFTypeRef,
            c_str: *const c_char,
            encoding: CFStringEncoding,
        ) -> CFStringRef;
        fn CFPreferencesCopyAppValue(key: CFStringRef, application_id: CFStringRef) -> CFTypeRef;
        fn CFGetTypeID(cf: CFTypeRef) -> CFTypeID;
        fn CFStringGetTypeID() -> CFTypeID;
        fn CFStringGetCString(
            string: CFStringRef,
            buffer: *mut c_char,
            buffer_size: CFIndex,
            encoding: CFStringEncoding,
        ) -> Boolean;
        fn CFRelease(cf: CFTypeRef);
    }

    /// `AppleLocale` from the global preferences domain.
    pub(super) fn apple_locale() -> Option<String> {
        // SAFETY: every object created or copied here is released exactly
        // once; the value is read as a string only after its type says it is
        // one; and `CStr::from_ptr` runs only once `CFStringGetCString` has
        // reported writing a NUL-terminated string into `buf`.
        unsafe {
            let key = CFStringCreateWithCString(std::ptr::null(), c"AppleLocale".as_ptr(), UTF8);
            if key.is_null() {
                return None;
            }
            let value = CFPreferencesCopyAppValue(key, kCFPreferencesAnyApplication);
            CFRelease(key);
            if value.is_null() {
                return None;
            }
            let mut buf: [c_char; 128] = [0; 128];
            let copied = CFGetTypeID(value) == CFStringGetTypeID()
                && CFStringGetCString(value, buf.as_mut_ptr(), buf.len() as CFIndex, UTF8) != 0;
            CFRelease(value);
            if !copied {
                return None;
            }
            CStr::from_ptr(buf.as_ptr()).to_str().ok().map(str::to_owned)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// An environment holding exactly `vars`, looked up the way `spawn` does.
    fn env<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<OsString> + 'a {
        move |key| vars.iter().find(|(k, _)| *k == key).map(|(_, v)| OsString::from(v))
    }

    /// A machine on which exactly `names` can be loaded.
    fn has<'a>(names: &'a [&'a str]) -> impl Fn(&str) -> bool + 'a {
        move |name| names.contains(&name)
    }

    /// The part of a Mac's /usr/share/locale these cases need. There is no
    /// `en_KR.UTF-8`, just as there is none on a real Mac.
    const MAC: &[&str] = &[
        "C.UTF-8",
        "de_AT.UTF-8",
        "de_DE.UTF-8",
        "en_GB.UTF-8",
        "en_US.UTF-8",
        "ko_KR.UTF-8",
        "zh_CN.UTF-8",
        "zh_TW.UTF-8",
    ];

    /// A Debian or Ubuntu system nobody has run locale-gen on.
    const BARE_LINUX: &[&str] = &["C.UTF-8"];

    fn on_mac(apple_locale: &str) -> Option<String> {
        lang_to_set(env(&[]), System::Mac(Some(apple_locale)), has(MAC))
    }

    #[test]
    fn a_shell_that_inherits_no_locale_is_given_a_utf8_one() {
        assert_eq!(on_mac("ko_KR").as_deref(), Some("ko_KR.UTF-8"));
        assert_eq!(
            lang_to_set(env(&[]), System::Other, has(BARE_LINUX)).as_deref(),
            Some("C.UTF-8")
        );
    }

    /// The user's locale always wins — even `C`, which somebody chose, and
    /// even a name this machine cannot load, which is theirs to fix.
    #[test]
    fn any_one_of_the_three_is_left_exactly_as_it_is() {
        let inherited: &[&[(&str, &str)]] = &[
            &[("LANG", "C")],
            &[("LANG", "POSIX")],
            &[("LANG", "ko_KR.UTF-8")],
            &[("LANG", "en_KR.UTF-8")],
            // A bare character set, as macOS terminals set it when the
            // user's language and region make no locale.
            &[("LC_CTYPE", "UTF-8")],
            &[("LC_CTYPE", "C")],
            &[("LC_ALL", "C")],
            &[("LC_ALL", "en_US.UTF-8")],
            // One set is enough, whatever the others are.
            &[("LANG", ""), ("LC_ALL", ""), ("LC_CTYPE", "ko_KR.UTF-8")],
        ];
        for system in [System::Mac(Some("ko_KR")), System::Other] {
            // Without the variable there IS an answer, so a `None` below is
            // the variable being respected rather than nothing being found.
            assert!(lang_to_set(env(&[]), system, has(MAC)).is_some());
            for vars in inherited {
                assert_eq!(
                    lang_to_set(env(vars), system, has(MAC)),
                    None,
                    "{vars:?} was overridden on {system:?}"
                );
            }
        }
    }

    /// The C library skips an empty variable as if it were not there, so a
    /// shell given three empty ones still starts in C.
    #[test]
    fn an_empty_variable_counts_as_unset() {
        let empty = [("LC_ALL", ""), ("LC_CTYPE", ""), ("LANG", "")];
        assert_eq!(
            lang_to_set(env(&empty), System::Mac(Some("ko_KR")), has(MAC)).as_deref(),
            Some("ko_KR.UTF-8")
        );
        assert_eq!(
            lang_to_set(env(&empty), System::Other, has(BARE_LINUX)).as_deref(),
            Some("C.UTF-8")
        );
    }

    /// `LC_MESSAGES` and the rest say nothing about the character set, so
    /// with only those the shell is still in C. Setting LANG does not undo
    /// them either: every `LC_` variable outranks LANG.
    #[test]
    fn the_other_lc_variables_do_not_count() {
        let vars = [("LC_MESSAGES", "ko_KR.UTF-8"), ("LC_TIME", "C")];
        assert_eq!(
            lang_to_set(env(&vars), System::Mac(Some("en_US")), has(MAC)).as_deref(),
            Some("en_US.UTF-8")
        );
    }

    /// The machine this was found on: English, region Korea. macOS has no
    /// `en_KR.UTF-8`, and a LANG naming it fails in `setlocale` and leaves the
    /// shell in C — no better than no LANG at all.
    #[test]
    fn a_region_macos_has_no_locale_for_falls_back_to_the_languages_own() {
        assert_eq!(on_mac("en_KR").as_deref(), Some("en_US.UTF-8"));
        // The language's own main region, not English.
        assert_eq!(on_mac("ko_US").as_deref(), Some("ko_KR.UTF-8"));
        assert_eq!(on_mac("de_KR").as_deref(), Some("de_DE.UTF-8"));
        // A language with no region at all.
        assert_eq!(on_mac("ko").as_deref(), Some("ko_KR.UTF-8"));
        // Chinese is filed by script as much as by region.
        assert_eq!(on_mac("zh-Hant_KR").as_deref(), Some("zh_TW.UTF-8"));
        assert_eq!(on_mac("zh-Hans_KR").as_deref(), Some("zh_CN.UTF-8"));
    }

    #[test]
    fn a_locale_macos_has_is_used_as_it_is() {
        assert_eq!(on_mac("ko_KR").as_deref(), Some("ko_KR.UTF-8"));
        // Not replaced by the language's main region when it exists.
        assert_eq!(on_mac("de_AT").as_deref(), Some("de_AT.UTF-8"));
        assert_eq!(on_mac("en_GB").as_deref(), Some("en_GB.UTF-8"));
        assert_eq!(on_mac("zh-Hant_TW").as_deref(), Some("zh_TW.UTF-8"));
    }

    /// What macOS writes when a region's formats are overridden or another
    /// calendar is chosen. A POSIX locale name has no keywords.
    #[test]
    fn keywords_are_not_part_of_the_name() {
        assert_eq!(on_mac("ko_KR@calendar=buddhist").as_deref(), Some("ko_KR.UTF-8"));
        // A region that is not the language's main one, so that losing it to
        // the keyword would show rather than fall back to the same answer.
        assert_eq!(on_mac("en_GB@rg=krzzzz").as_deref(), Some("en_GB.UTF-8"));
        assert_eq!(on_mac("de_AT@currency=EUR").as_deref(), Some("de_AT.UTF-8"));
    }

    #[test]
    fn no_region_setting_or_a_meaningless_one_falls_back_to_en_us() {
        assert_eq!(
            lang_to_set(env(&[]), System::Mac(None), has(MAC)).as_deref(),
            Some("en_US.UTF-8")
        );
        for nonsense in ["", "C", "UTF-8", "xx_YY", "ko KR", "../../etc/passwd", "_KR", "@"] {
            assert_eq!(on_mac(nonsense).as_deref(), Some("en_US.UTF-8"), "{nonsense:?}");
        }
    }

    #[test]
    fn linux_prefers_c_utf8_then_en_us() {
        assert_eq!(
            lang_to_set(env(&[]), System::Other, has(&["C.UTF-8", "en_US.UTF-8"])).as_deref(),
            Some("C.UTF-8")
        );
        assert_eq!(
            lang_to_set(env(&[]), System::Other, has(&["en_US.UTF-8"])).as_deref(),
            Some("en_US.UTF-8")
        );
    }

    /// A LANG naming a locale that is not there is exactly as broken as none.
    #[test]
    fn nothing_is_chosen_when_the_machine_has_none_of_the_candidates() {
        assert_eq!(lang_to_set(env(&[]), System::Mac(Some("en_KR")), has(&[])), None);
        assert_eq!(lang_to_set(env(&[]), System::Other, has(&[])), None);
        assert_eq!(lang_to_set(env(&[]), System::Other, has(&["de_DE.UTF-8"])), None);
    }

    /// `newlocale("")` loads whatever THIS process's environment names, and a
    /// name with a slash in it is a path. Neither may reach the probe,
    /// whatever `AppleLocale` holds.
    #[test]
    fn only_plain_locale_names_are_ever_probed() {
        let asked = RefCell::new(Vec::new());
        let record = |name: &str| {
            asked.borrow_mut().push(name.to_string());
            false
        };
        for apple_locale in [
            None,
            Some(""),
            Some("_"),
            Some("-"),
            Some("@"),
            Some("en_"),
            Some("_KR"),
            Some("en_KR/../../x"),
            Some("../../etc/passwd"),
            Some("ko_KR.UTF-8"),
            Some("en_KR.ISO8859-1"),
            Some("zh-Hant"),
            Some("es_419"),
            Some("ko\0KR"),
        ] {
            lang_to_set(env(&[]), System::Mac(apple_locale), record);
        }
        lang_to_set(env(&[]), System::Other, record);

        let asked = asked.into_inner();
        assert!(!asked.is_empty());
        for name in &asked {
            let plain = name == "C.UTF-8"
                || name.strip_suffix(".UTF-8").is_some_and(|base| {
                    let (language, region) = base.split_once('_').unwrap_or((base, ""));
                    (2..=3).contains(&language.len())
                        && language.bytes().all(|b| b.is_ascii_lowercase())
                        && ((region.len() == 2 && region.bytes().all(|b| b.is_ascii_uppercase()))
                            || (region.len() == 3 && region.bytes().all(|b| b.is_ascii_digit())))
                });
            assert!(plain, "the probe was asked about {name:?}");
        }
    }

    // --- The machine half, on the machine the suite runs on. ---

    #[test]
    fn this_machine_gets_a_utf8_locale_it_can_load() {
        let lang = lang_for(|_| None).expect("no UTF-8 locale was found on this machine");
        assert!(lang.ends_with(".UTF-8"), "{lang}");
        assert!(locale_exists(lang), "{lang} was chosen but the C library cannot load it");
    }

    /// On macOS the default follows the user's region setting. `C.UTF-8`
    /// would load there too, so a Mac quietly given the Linux answer would
    /// pass every other case here.
    #[test]
    fn the_default_is_derived_from_this_platforms_own_setting() {
        let apple_locale = apple_locale();
        let expected = if cfg!(target_os = "macos") {
            lang_to_set(|_| None, System::Mac(apple_locale.as_deref()), locale_exists)
        } else {
            assert_eq!(apple_locale, None, "only macOS has a region setting to read");
            lang_to_set(|_| None, System::Other, locale_exists)
        };
        assert_eq!(lang_for(|_| None), expected.as_deref());
    }

    /// The machine half is worked out once; the environment half still has to
    /// be looked at on every spawn.
    #[test]
    fn a_locale_in_the_environment_wins_after_the_default_is_cached() {
        let default = lang_for(|_| None);
        assert!(default.is_some());
        assert_eq!(lang_for(env(&[("LANG", "C")])), None);
        assert_eq!(lang_for(env(&[("LC_CTYPE", "UTF-8")])), None);
        assert_eq!(lang_for(env(&[("LC_ALL", "C")])), None);
        assert_eq!(lang_for(env(&[("LANG", "")])), default);
    }

    #[test]
    fn the_probe_is_the_c_librarys_own_answer() {
        assert!(locale_exists("C"), "C always exists");
        assert!(!locale_exists("xx_NOWHERE.UTF-8"));
        // "" would load the locale THIS process's environment names.
        assert!(!locale_exists(""));
        assert!(!locale_exists("en_US\0.UTF-8"));
        if cfg!(target_os = "macos") {
            assert!(locale_exists("en_US.UTF-8"));
            assert!(locale_exists("ko_KR.UTF-8"));
            assert!(!locale_exists("en_KR.UTF-8"), "macOS has no en_KR.UTF-8");
            // The bare `UTF-8` of `LC_CTYPE=UTF-8` is a character set and
            // nothing else. As a LANG it would make `setlocale(LC_ALL, "")`
            // fail, so it is not a locale for this purpose.
            assert!(!locale_exists("UTF-8"));
        }
    }

    /// Read without running `defaults`, but it has to be the same value where
    /// `defaults` has one.
    ///
    /// Not the same question everywhere: `defaults read -g` reads only the
    /// user's own global domain, while CFPreferences with
    /// `kCFPreferencesAnyApplication` also falls back to the machine-wide one
    /// in /Library/Preferences. A Mac whose region is set only there — a fresh
    /// or managed one, possibly a CI image — has `defaults` fail where the
    /// read here rightly finds a value. So the two are compared when the user
    /// has one, and otherwise the value found must at least look like a
    /// locale identifier.
    #[cfg(target_os = "macos")]
    #[test]
    fn apple_locale_is_what_defaults_reads() {
        let out = std::process::Command::new("defaults")
            .args(["read", "-g", "AppleLocale"])
            .output()
            .expect("run defaults");
        if out.status.success() {
            let expected = String::from_utf8_lossy(&out.stdout).trim().to_string();
            assert_eq!(apple_locale(), Some(expected));
        } else if let Some(found) = apple_locale() {
            assert!(
                !found.is_empty() && !found.chars().any(char::is_whitespace),
                "not a locale identifier: {found:?}"
            );
        }
    }

    /// The table, checked against the Mac rather than trusted: every entry is
    /// a locale macOS really has, and every language macOS has a UTF-8 locale
    /// for has an entry, so the language fallback is never a guess.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_main_region_table_matches_what_macos_ships() {
        for (language, region) in MAIN_REGION {
            let name = format!("{language}_{region}.UTF-8");
            assert!(locale_exists(&name), "{name} is in the table but macOS cannot load it");
        }
        let shipped: std::collections::BTreeSet<String> = std::fs::read_dir("/usr/share/locale")
            .expect("read /usr/share/locale")
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter_map(|name| {
                let base = name.strip_suffix(".UTF-8")?;
                Some(base.split_once('_')?.0.to_string())
            })
            .collect();
        assert!(shipped.contains("ko"), "the scan found no ko_*.UTF-8: {shipped:?}");
        for language in shipped {
            assert!(
                MAIN_REGION.iter().any(|(l, _)| *l == language),
                "macOS has UTF-8 locales for {language:?} but the table has no region for it"
            );
        }
    }
}

// Rules live here as data. Settings can override every field. The editor, the
// local audit, and the Claude Project setup text all read the same object.

const SUBJECTS = ['the state', 'the government', 'society', 'the country'];
const VERBS = ['wants', 'believes', 'thinks', 'feels', 'knows', 'decides', 'decided', 'fears', 'demands'];

export const AUDIT_CATEGORIES = [
  { id: 'reform',     label: 'Reform appeal' },
  { id: 'mystic',     label: 'Mystical State or collective' },
  { id: 'vague',      label: 'Vague attribution' },
  { id: 'hedge',      label: 'Hedging' },
  { id: 'inflation',  label: 'Significance inflation' },
  { id: 'conclusion', label: 'Generic conclusion' },
  { id: 'chatbot',    label: 'Chatbot or sycophantic phrasing' },
];

export const DEFAULT_RULES = {
  maxPassivePct: 10,
  maxSentencesPerParagraph: 6,
  maxEmDashPer1000: 4,

  forbidden: [
    'additionally', 'testament', 'a testament to', 'landscape', 'showcasing',
    'delve', 'tapestry', 'pivotal', 'vibrant', 'underscores', 'fostering',
    'realm', 'crucial', 'serves as', 'stands as', 'boasts',
    'plays a vital role', 'plays a crucial role', 'game-changer',
    'experts believe', 'experts say', 'studies show', 'many believe',
    "it's worth noting", 'that said', 'the key thing', 'in short',
    'ultimately', 'in conclusion', 'i hope this helps', 'great question',
    'let me know if',
  ],

  // Phrase lists for the local audit. One phrase per line in Settings.
  audit: {
    reform: [
      'the state should', 'the government should', 'government should',
      'should be reformed', 'must be reformed', 'needs reform', 'reform the',
      'better government', 'limited government', 'smaller government',
      'good governance', 'common-sense reform', 'common sense reform',
      'vote them out', 'hold them accountable', 'hold politicians accountable',
      'checks and balances', 'constitutional limits',
    ],
    mystic: SUBJECTS.flatMap((s) => VERBS.map((v) => `${s} ${v}`)),
    vague: [
      'experts agree', 'research shows', 'research suggests', 'studies suggest',
      'many people', 'some say', 'critics say', 'critics argue', 'many argue',
      'some argue', 'it is widely believed', 'it is well known', 'it is often said',
      'observers note', 'analysts say', 'commentators say', 'scholars agree',
    ],
    hedge: [
      'arguably', 'it could be argued', 'one might argue', 'it seems that',
      'to some extent', 'in many ways', 'generally speaking', 'more or less',
      'perhaps', 'in some sense', 'tends to',
    ],
    inflation: [
      'a pivotal moment', 'a turning point', 'indelible mark', 'enduring legacy',
      'groundbreaking', 'revolutionary', 'unprecedented', 'profound impact',
      "in today's world", 'in an era of', 'at the end of the day', 'rich tapestry',
      'ever-evolving', 'shaping the future', 'a new era', 'sends a clear message',
      'speaks volumes',
    ],
    conclusion: [
      'to sum up', 'in summary', 'all in all', 'the bottom line',
      'only time will tell', 'remains to be seen', 'the future looks',
      'moving forward', 'going forward', 'looking ahead',
      'where do we go from here', 'the choice is clear', 'the path forward',
    ],
    chatbot: [
      'certainly!', 'absolutely!', 'great point', 'excellent point',
      'excellent question', 'happy to help', 'feel free to', 'as an ai',
      'here is a breakdown', "here's a breakdown", "let's dive", "let's unpack",
      'would you like me to', "you're absolutely right", 'you are absolutely right',
      'what a fascinating',
    ],
  },

  voiceProfile: `Voice: modern, sharp, merciless. Mock institutions; do not debate them politely. No aristocratic, nostalgic, or religious framing. Active voice. Zero fluff: every sentence advances the argument. Specific facts over formulaic challenges.

Philosophy: voluntaryist / anarcho-capitalist. Only individuals are moral agents. Self-ownership is the anchor and the NAP governs moral life. The State is specific individuals using a monopoly on force to pursue advantage; name the individuals and the beneficiaries, never write about it as a mystical entity. Taxation is theft, stated without hedging. Every State function can be performed by voluntary exchange; point to those alternatives. Never suggest political reform, "better government," or what the State "should" do. Never use comfort or stability as a moral argument.

Economics: Austrian (Mises, Rothbard). Free markets versus rigged markets. Central banking is organized counterfeiting.

Also: judge individuals by actions; reject group guilt, racism, and sexism. Anti-war, anti-empire. Speech is not violence. Truth requires skepticism, evidence, and debate.

Mechanical patterns to avoid: significance inflation, vague attributions, AI vocabulary, copula avoidance (serves as, boasts), the rule of three, chatbot artifacts, sycophantic tone, generic conclusions.`,
};

export function cloneRules(r = DEFAULT_RULES) {
  return JSON.parse(JSON.stringify(r));
}

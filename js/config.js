// The only file you need to edit to connect the site to your own Supabase project.
// The anon key is MEANT to be public: it only allows what the row level security
// rules in supabase/schema.sql allow. Never put a service role key or a Stripe
// secret key anywhere in this folder.
export const CONFIG = {
  appName: "SideQuest",
  supabaseUrl: "https://gpmfjifxxuwretqfroxs.supabase.co",
  supabaseAnonKey: "sb_publishable_8qOksnvJrE5liHEsDyHV8A_VMc0gfQU",
  stripePublishableKey: "pk_test_51UchANDcrsR7GnQBxBAHSO8gcUhXo0pQZ0vMV7Ykbokbx5kVNTuU1PgIelwYSumMuf0PYbWPkP2Bv4tNWyLyywTP00TiJfVbov",

  // Suggested deposit when someone posts a task: this share of the reward, never less than the minimum.
  // (The database enforces at least 10% of the reward and at least RM 5.)
  depositPercent: 20,
  minDepositSen: 500,
  maxDepositSen: 50000,
  minRewardSen: 500,
  maxRewardSen: 500000,
};

export const CATEGORIES = [
  { id: "home", label: "Around the house" },
  { id: "garden", label: "Plants and garden" },
  { id: "pets", label: "Pets" },
  { id: "errands", label: "Errands" },
  { id: "creative", label: "Art and crafts" },
  { id: "tutoring", label: "Lessons and tutoring" },
  { id: "moving", label: "Moving and carrying" },
  { id: "tech", label: "Phones and computers" },
  { id: "other", label: "Something else" },
];

export const categoryLabel = (id) => CATEGORIES.find((c) => c.id === id)?.label ?? "Something else";

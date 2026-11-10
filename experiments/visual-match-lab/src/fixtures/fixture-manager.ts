export interface FixtureItem {
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  isRealFixture: boolean;
  dataUrl: string;
}

const STORAGE_KEY = 'visual_match_lab_custom_fixtures';

export class FixtureManager {
  /**
   * Generates a realistic 702x41 calibration image matching Facebook action bar geometry:
   * - Like icon + "90"
   * - Comment icon + "62"
   * - Share icon + "60"
   * - Reaction emoji cluster on the right (distractor)
   */
  public static createSynthetic702x41(): FixtureItem {
    const canvas = document.createElement('canvas');
    canvas.width = 702;
    canvas.height = 41;
    const ctx = canvas.getContext('2d')!;

    // Background: FB clean bar background #FFFFFF or #F0F2F5
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, 702, 41);

    // Subtle divider border on top
    ctx.strokeStyle = '#E4E6EB';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 0.5);
    ctx.lineTo(702, 0.5);
    ctx.stroke();

    // Text style
    ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = '#65676B';
    ctx.textBaseline = 'middle';

    // 1. Like Action Unit (Leftmost)
    // Draw Thumbs Up icon (approx 18x18 at x=18, y=11)
    const iconColor = '#65676B';
    ctx.fillStyle = iconColor;
    ctx.strokeStyle = iconColor;
    ctx.lineWidth = 1.6;

    // Like icon (Thumbs Up path)
    ctx.beginPath();
    // Sleeve cuff
    ctx.rect(18, 17, 3, 11);
    ctx.fill();
    // Hand & thumb
    ctx.beginPath();
    ctx.moveTo(23, 20);
    ctx.lineTo(26, 13);
    ctx.arc(28, 13, 2, Math.PI, 0, false);
    ctx.lineTo(27, 18);
    ctx.lineTo(35, 18);
    ctx.arc(35, 20, 2, -Math.PI / 2, Math.PI / 2, false);
    ctx.lineTo(34, 23);
    ctx.arc(34, 25, 2, -Math.PI / 2, Math.PI / 2, false);
    ctx.lineTo(33, 27);
    ctx.arc(33, 28, 1.5, -Math.PI / 2, Math.PI / 2, false);
    ctx.lineTo(23, 28);
    ctx.closePath();
    ctx.stroke();
    // Number "90"
    ctx.fillText('90', 42, 21);

    // 2. Comment Action Unit
    // Speech bubble icon (approx 18x18 at x=105, y=12)
    ctx.beginPath();
    ctx.roundRect(105, 12, 17, 14, 4);
    ctx.stroke();
    // Bubble tail
    ctx.beginPath();
    ctx.moveTo(109, 26);
    ctx.lineTo(106, 29);
    ctx.lineTo(113, 26);
    ctx.fill();
    // Number "62"
    ctx.fillText('62', 128, 21);

    // 3. Share Action Unit
    // Curved forward arrow (approx 18x18 at x=190, y=12)
    ctx.beginPath();
    ctx.moveTo(192, 24);
    ctx.quadraticCurveTo(196, 17, 204, 16);
    ctx.lineTo(204, 13);
    ctx.lineTo(210, 18);
    ctx.lineTo(204, 23);
    ctx.lineTo(204, 20);
    ctx.quadraticCurveTo(198, 21, 195, 26);
    ctx.closePath();
    ctx.stroke();
    // Number "60"
    ctx.fillText('60', 216, 21);

    // 4. Reaction Emoji Cluster on Right (Distractor)
    // Overlapping reaction circles: Like (blue), Love (red), Haha (yellow)
    const rightClusterX = 610;
    // Blue Like circle
    ctx.fillStyle = '#1877F2';
    ctx.beginPath();
    ctx.arc(rightClusterX, 21, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Red Love heart circle
    ctx.fillStyle = '#FA383E';
    ctx.beginPath();
    ctx.arc(rightClusterX + 13, 21, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Yellow Haha emoji circle
    ctx.fillStyle = '#F7B125';
    ctx.beginPath();
    ctx.arc(rightClusterX + 26, 21, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Reaction count on far right e.g. "212"
    ctx.fillStyle = '#65676B';
    ctx.font = '500 12px -apple-system, sans-serif';
    ctx.fillText('212', rightClusterX + 40, 21);

    return {
      id: 'synthetic_702x41',
      name: 'Calibration Fixture (702 × 41 px)',
      description: 'Geometry: Like+90, Comment+62, Share+60, Reaction cluster distractor right',
      width: 702,
      height: 41,
      isRealFixture: false,
      dataUrl: canvas.toDataURL('image/png'),
    };
  }

  /**
   * Generates a secondary target screenshot (702x120 px) with modified counts & positions
   * for testing Stage E Visual Template Matching.
   */
  public static createTargetSampleImage(): FixtureItem {
    const canvas = document.createElement('canvas');
    canvas.width = 702;
    canvas.height = 120;
    const ctx = canvas.getContext('2d')!;

    // Background
    ctx.fillStyle = '#F0F2F5';
    ctx.fillRect(0, 0, 702, 120);

    // Post card container
    ctx.fillStyle = '#FFFFFF';
    ctx.roundRect(10, 10, 682, 100, 8);
    ctx.fill();
    ctx.strokeStyle = '#CED0D4';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Post sample text
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#050505';
    ctx.fillText('Sample social feed post with action bar below for visual matching test...', 30, 40);

    // Separator line
    ctx.strokeStyle = '#E4E6EB';
    ctx.beginPath();
    ctx.moveTo(30, 65.5);
    ctx.lineTo(672, 65.5);
    ctx.stroke();

    // Embedded action bar at y=70: Thumbs Up icon at (x=45, y=76), Comment at (x=160), Share at (x=275)
    ctx.fillStyle = '#65676B';
    ctx.strokeStyle = '#65676B';
    ctx.lineWidth = 1.6;

    // Like icon
    ctx.beginPath();
    ctx.rect(45, 80, 3, 11);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(50, 83);
    ctx.lineTo(53, 76);
    ctx.arc(55, 76, 2, Math.PI, 0, false);
    ctx.lineTo(54, 81);
    ctx.lineTo(62, 81);
    ctx.arc(62, 83, 2, -Math.PI / 2, Math.PI / 2, false);
    ctx.lineTo(61, 86);
    ctx.arc(61, 88, 2, -Math.PI / 2, Math.PI / 2, false);
    ctx.lineTo(60, 90);
    ctx.arc(60, 91, 1.5, -Math.PI / 2, Math.PI / 2, false);
    ctx.lineTo(50, 91);
    ctx.closePath();
    ctx.stroke();

    ctx.font = '600 13px sans-serif';
    ctx.fillText('1.2K', 69, 85);

    // Comment icon
    ctx.beginPath();
    ctx.roundRect(160, 76, 17, 14, 4);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(164, 90);
    ctx.lineTo(161, 93);
    ctx.lineTo(168, 90);
    ctx.fill();
    ctx.fillText('345', 183, 85);

    // Distractor icon elsewhere (e.g. search magnifying glass or bookmark)
    ctx.beginPath();
    ctx.arc(480, 83, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(485, 88);
    ctx.lineTo(491, 94);
    ctx.stroke();

    return {
      id: 'target_sample_702x120',
      name: 'Target Screenshot (702 × 120 px)',
      description: 'Feed post containing Like/Comment icons in different positions with counts',
      width: 702,
      height: 120,
      isRealFixture: false,
      dataUrl: canvas.toDataURL('image/png'),
    };
  }

  /**
   * Load all saved custom fixtures from LocalStorage
   */
  public static loadCustomFixtures(): FixtureItem[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  /**
   * Save a newly imported real fixture
   */
  public static saveCustomFixture(item: FixtureItem): void {
    const list = this.loadCustomFixtures().filter((f) => f.id !== item.id);
    list.unshift(item);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  /**
   * Create FixtureItem from a File object
   */
  public static async importFromFile(file: File): Promise<FixtureItem> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        const img = new Image();
        img.onload = () => {
          const item: FixtureItem = {
            id: `real_fixture_${Date.now()}`,
            name: file.name,
            description: `Imported screenshot (${img.width} × ${img.height} px)`,
            width: img.width,
            height: img.height,
            isRealFixture: true,
            dataUrl,
          };
          FixtureManager.saveCustomFixture(item);
          resolve(item);
        };
        img.onerror = reject;
        img.src = dataUrl;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
}

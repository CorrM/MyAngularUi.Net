﻿using MAU.Attributes;
using System;
using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;
using static MAU.Events.MauEventHandlers;

namespace MAU.ReadyElement
{
	public class MauSelect : MauElement
	{
		#region [ Events ]

		[MauEvent("selectionChange")]
		public event MauEventHandler SelectionChange;

		#endregion

		#region [ Public Props ]

		[MauVariable]
		public List<string> Options { get; private set; }

		[MauProperty("role")]
		public string SelectedOption { get; set; }

		#endregion

		public MauSelect(MauComponent parentComponent, string id) : base(parentComponent, id)
		{
			Options = new List<string>();
		}

		public void UpdateOptions()
		{
			MauVariable.UpdateVar(this, nameof(Options));
		}
	}
}
